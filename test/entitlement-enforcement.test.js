const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ids = (id) => ({ 'test-ems-server-product-id': id, 'production-ems-server-product-id': id });
const formJson = {
  'base-product-id': ids('60'),
  'highest-product-key-serial-number-customer-id': '1010',
  'lease-expiry-range': { 'min-months': 6, 'max-months': 24 },
  'product-options': { standalone: { label: 'Standalone', ...ids('6048') }, link: { label: 'Link', ...ids('6049') } },
  'optional-products': { pivot: { label: 'Pivot', ...ids('6051') } },
  version: { v22: { label: 'Version 22', ...ids('') }, v23: { label: 'Version 23', ...ids('6052') } },
  lease: { lease: { label: 'Lease', ...ids('6050') } },
};

function createRoute(enforcements, clock = new Date(2026, 10, 10, 12), baseMemory = [], pivotAvailable = true, leaseAvailable = true, versionAvailable = true, existingStartDate = '2026-11-10', serialOptions = {}) {
  let handler;
  let updateHandler;
  let serialHandler;
  let usedSerialsHandler;
  let productKeysHandler;
  let activateHandler;
  let produceHandler;
  let reopenHandler;
  let deleteHandler;
  let saved;
  const events = [];
  const entitlements = serialOptions.entitlements || [];
  const entitlementDetails = { ...(serialOptions.entitlementDetails || {}) };
  let largest = serialOptions.largest ?? 42;
  class EmsClient {
    constructor() { this.authenticated = true; this.cookies = new Map(); }
    async listCustomers() { return [{ customerId: '5' }]; }
    async listEntitlements() { return entitlements; }
    async getLargestProductKeySerial() { events.push('get'); if (serialOptions.getError) throw new Error('serial read failed'); return largest; }
    async setLargestProductKeySerial(value) { events.push(`set:${value}`); if (serialOptions.setError) throw new Error('serial write failed'); if (serialOptions.beforeSet) await serialOptions.beforeSet(value); largest = value; }
    async getProductSummary(id) {
      assert.equal(id, '60');
      return { id: '60', lifeCycleStage: 'Commit', enforcementProductType: 'BASE' };
    }
    async listModificationProducts(id) {
      assert.equal(id, '60');
      return [{ productId: '6048', productName: '01 ADD Standalone', lifeCycleStage: 'Commit' },
        { productId: '6049', productName: '02 ADD Link', lifeCycleStage: 'Commit' },
        { productId: '6051', productName: '04 ADD Pivot', lifeCycleStage: pivotAvailable ? 'Commit' : 'Draft' },
        { productId: '6050', productName: '03 Lease version - fill out Expiry Date', lifeCycleStage: leaseAvailable ? 'Commit' : 'Draft' },
        { productId: '6052', productName: '05 Set VERSION 23', lifeCycleStage: versionAvailable ? 'Commit' : 'Draft' },
        { productId: '12', productName: 'Modification', lifeCycleStage: 'Commit' },
        { productId: '13', productName: 'Draft', lifeCycleStage: 'Draft' }];
    }
    async listEnforcements() { return enforcements; }
    async getProductReadOnlyMemory(id) { return String(id) === '60' ? [...baseMemory, { kind: 'product', segments: [{ id: '999', name: 'Serial Number', size: '4', saot: true }] }] : []; }
    async createEntitlement(data) {
      events.push('create');
      if (serialOptions.createError) throw new Error('create failed');
      saved = data;
      if (serialOptions.recordCreatedEntitlements) {
        const id = String(1000 + entitlements.length);
        entitlements.push({ id });
        entitlementDetails[id] = {
          id,
          products: [{
            productId: '60',
            memorySegments: data.memorySegments.map((segment) => ({
              name: 'Serial Number',
              saot: true,
              text: segment.content,
            })),
          }],
        };
      }
      return { saved: true };
    }
    async getEntitlementDetails(id) {
      return entitlementDetails[id] || { id, entState: 'DRAFT', eid: 'test-eid', refId1: '00123', startDate: existingStartDate };
    }
    async getEntitlementProductKeys(id) { return [{ productKeyId: 'key-001', entitlementId: id }]; }
    async activateProductKey(key, c2v) {
      events.push(`activate:${key}`);
      if (serialOptions.activateError) throw serialOptions.activateError;
      return { aid: 'aid-1', license: c2v };
    }
    async updateEntitlement(_id, data) { saved = data; return { saved: true }; }
    async produceEntitlement(id) {
      events.push(`produce:${id}`);
      if (serialOptions.produceError) throw serialOptions.produceError;
      return { produced: true, entId: id };
    }
    async reopenEntitlement(id) {
      events.push(`reopen:${id}`);
      if (serialOptions.reopenError) throw serialOptions.reopenError;
      return { reopened: true, entId: id, state: 'DRAFT' };
    }
    async deleteEntitlement(id) { events.push(`delete:${id}`); return { deleted: true, entId: id }; }
  }
  const app = {
    get(route, ...handlers) {
      if (route === '/api/product-key-serial-number') serialHandler = handlers.at(-1);
      if (route === '/api/product-key-serial-numbers') usedSerialsHandler = handlers.at(-1);
      if (route === '/api/entitlements/:id/product-keys') productKeysHandler = handlers.at(-1);
    },
    post(route, ...handlers) {
      if (route === '/api/entitlements') handler = handlers.at(-1);
      if (route === '/api/entitlements/:id/produce') produceHandler = handlers.at(-1);
      if (route === '/api/entitlements/:id/activate') activateHandler = handlers.at(-1);
      if (route === '/api/entitlements/:id/reopen') reopenHandler = handlers.at(-1);
    },
    put(route, ...handlers) { if (route === '/api/entitlements/:id') updateHandler = handlers.at(-1); },
    delete(route, ...handlers) { if (route === '/api/entitlements/:id') deleteHandler = handlers.at(-1); },
    use() {},
    listen() {},
  };
  const express = () => app;
  express.static = () => {};
  express.json = () => {};
  const root = path.join(__dirname, '..');
  const customRequire = (name) => {
    if (name === 'express') return express;
    if (name === 'fs') return { existsSync: () => false, watch() {} };
    if (name === './ems-client') return { EmsClient };
    if (name === './act-client') return { ActClient: class {} };
    if (name === './act-sessions') return require('../src/act-sessions');
    if (name === './ems-config') return require('../src/ems-config');
    if (name === './product-key-serials') return require('../src/product-key-serials');
    if (name === './environment') return require('../src/environment');
    if (name === './entitlement-memory') return require('../src/entitlement-memory');
    if (name === './entitlement-form-data') return { loadFormData: () => require('../src/entitlement-form-data').parseFormData(formJson, false) };
    if (name === '../public/lease-dates') return require('../public/lease-dates');
    if (name === './page-includes') return require('../src/page-includes');
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8'), {
    require: customRequire,
    __dirname: path.join(root, 'src'),
    process: { argv: ['node', 'server.js'], env: { IS_TEST_MODE: 'false', PRODUCTION_EMS_URL: 'https://ems.example', ACT_URL: 'https://act.example' } },
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [clock.getTime()])); }
    },
    Buffer,
    console,
  });
  const ems = new EmsClient();
  return {
    events,
    async activate(id, body) {
      const res = {
        statusCode: 200,
        set(name, value) { this.headers = { [name]: value }; return this; },
        status(code) { this.statusCode = code; return this; },
        json(data) { this.body = data; return this; },
      };
      await activateHandler({ params: { id }, body, ems }, res);
      return res;
    },
    async getProductKeys(id) {
      const res = {
        statusCode: 200,
        set(name, value) { this.headers = { [name]: value }; return this; },
        status(code) { this.statusCode = code; return this; },
        json(data) { this.body = data; return this; },
      };
      await productKeysHandler({ params: { id }, ems }, res);
      return res;
    },
    async produce(id) {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.body = data; return this; },
      };
      await produceHandler({ params: { id }, ems }, res);
      return res;
    },
    async reopen(id) {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.body = data; return this; },
      };
      await reopenHandler({ params: { id }, ems }, res);
      return res;
    },
    async delete(id) {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.body = data; return this; },
      };
      await deleteHandler({ params: { id }, ems }, res);
      return res;
    },
    async getSerial() {
      const res = {
        statusCode: 200,
        set(name, value) { this.headers = { [name]: value }; return this; },
        status(code) { this.statusCode = code; return this; },
        json(data) { this.body = data; return this; },
      };
      await serialHandler({ ems }, res);
      return res;
    },
    async getUsedSerials() {
      const res = {
        statusCode: 200,
        set(name, value) { this.headers = { [name]: value }; return this; },
        status(code) { this.statusCode = code; return this; },
        json(data) { this.body = data; return this; },
      };
      await usedSerialsHandler({ ems }, res);
      return res;
    },
    async submit(overrides = {}, update = false) {
      const req = { ems, params: update ? { id: '123' } : undefined, body: {
        customerId: '5', productIds: ['6048'],
        description: '', ...(!update ? { refId1: 'ORDER' } : {}), ...overrides,
      } };
      req.body.memoryValues = [...(req.body.memoryValues || []), { productId: '60', segmentId: '999', content: overrides.serialTestContent ?? serialOptions.serialContent ?? '31373731' }];
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.body = data; return this; },
      };
      await (update ? updateHandler : handler)(req, res);
      return { res, saved };
    },
  };
}

test('product key details route validates entitlement ID and prevents caching', async () => {
  const route = createRoute([]);
  const invalid = await route.getProductKeys('bad');
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.headers['Cache-Control'], 'no-store');
  const response = await route.getProductKeys('123');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body[0].productKeyId, 'key-001');
  assert.equal(response.headers['Cache-Control'], 'no-store');
});

test('activation validates the entitlement and key and does not retry uncertain outcomes', async () => {
  const activationEntitlement = {
    entitlementDetails: {
      123: {
        id: '123',
        entState: 'PRODUCT_KEY_GENERATED',
        entitlementItem: { lineItemType: 'Product_Key', productKeyId: 'key-001' },
      },
    },
  };
  const route = createRoute([], undefined, [], true, true, true, undefined, activationEntitlement);
  const body = { productKeyId: 'key-001', c2v: '<hasp_info/>' };
  assert.equal((await route.activate('0', body)).statusCode, 400);
  assert.equal((await route.activate('123', { ...body, productKeyId: 'other' })).statusCode, 400);
  assert.equal((await route.activate('123', { ...body, c2v: '' })).statusCode, 400);
  assert.deepEqual(route.events, []);
  const result = await route.activate('123', body);
  assert.equal(result.body.aid, 'aid-1');
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.deepEqual(route.events, ['activate:key-001']);

  const error = Object.assign(new Error('outcome unknown'), { outcomeUnknown: true, status: 401 });
  const failed = createRoute([], undefined, [], true, true, true, undefined, {
    ...activationEntitlement,
    activateError: error,
  });
  const response = await failed.activate('123', body);
  assert.equal(response.statusCode, 502);
  assert.equal(response.body.error, 'outcome unknown');
  assert.equal(response.body.outcomeUnknown, true);
  assert.deepEqual(failed.events, ['activate:key-001']);
});

test('produce route validates IDs and surfaces uncertain outcomes without retrying', async () => {
  const route = createRoute([]);
  assert.equal((await route.produce('0')).statusCode, 400);
  assert.equal(route.events.length, 0);
  assert.equal((await route.produce('123')).body.produced, true);
  assert.deepEqual(route.events, ['produce:123']);
  const error = Object.assign(new Error('outcome unknown'), { outcomeUnknown: true, status: 401 });
  const failed = createRoute([], undefined, [], true, true, true, undefined, { produceError: error });
  const response = await failed.produce('123');
  assert.equal(response.statusCode, 502);
  assert.equal(response.body.outcomeUnknown, true);
  assert.deepEqual(failed.events, ['produce:123']);
});

test('reopen route validates IDs and reports uncertain outcomes', async () => {
  const route = createRoute([]);
  assert.equal((await route.reopen('0')).statusCode, 400);
  assert.equal(route.events.length, 0);
  assert.equal((await route.reopen('123')).body.state, 'DRAFT');
  assert.deepEqual(route.events, ['reopen:123']);
  const error = Object.assign(new Error('outcome unknown'), { outcomeUnknown: true });
  const failed = createRoute([], undefined, [], true, true, true, undefined, { reopenError: error });
  const response = await failed.reopen('123');
  assert.equal(response.statusCode, 502);
  assert.equal(response.body.outcomeUnknown, true);
});

test('delete route only deletes draft entitlements', async () => {
  const draft = createRoute([]);
  assert.equal((await draft.delete('123')).body.deleted, true);
  assert.deepEqual(draft.events, ['delete:123']);

  const produced = createRoute([], undefined, [], true, true, true, undefined, {
    entitlementDetails: { 123: { entState: 'PRODUCT_KEY_GENERATED' } },
  });
  const response = await produced.delete('123');
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /Only draft entitlements can be deleted/);
  assert.deepEqual(produced.events, []);
});

test('serial number endpoint returns the highest stored serial without caching', async () => {
  const res = await createRoute([{ id: '1' }]).getSerial();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.largest, 42);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('used serial endpoint returns a flat list decoded from base entitlement memory', async () => {
  const route = createRoute([], undefined, [], true, true, true, undefined, {
    entitlements: [{ id: '100' }, { id: '101' }, { id: '102' }, { id: '103' }],
    entitlementDetails: {
      100: {
        id: '100', refId1: 'ORDER-100',
        products: [{ productId: '60', memorySegments: [{ name: 'Serial Number', saot: true, text: '30303032' }] }],
      },
      101: {
        id: '101', refId1: 'ORDER-101',
        products: [{ productId: '60', memorySegments: [{ name: 'Serial Number', saot: true, text: '30303033' }] }],
      },
      102: {
        id: '102', refId1: 'ORDER-102',
        products: [{ productId: '6048', memorySegments: [{ name: 'Serial Number', saot: true, text: '30303032' }] }],
      },
      103: {
        id: '103', refId1: 'ORDER-103',
        products: [{ productId: '60', memorySegments: [{ name: 'Serial Number', saot: true, text: '0004' }] }],
      },
    },
  });
  const response = await route.getUsedSerials();
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.deepEqual(Array.from(response.body), [2, 3, 4]);
});

test('rejects a serial number already used by an existing entitlement', async () => {
  const route = createRoute([{ id: '1' }], undefined, [], true, true, true, undefined, {
    entitlements: [{ id: '100' }],
    entitlementDetails: {
      100: {
        id: '100',
        products: [{
          productId: '60',
          memorySegments: [{ name: 'Serial Number', saot: true, text: '31373731' }],
        }],
      },
    },
  });
  const { res, saved } = await route.submit();
  assert.equal(res.statusCode, 409, JSON.stringify(res.body));
  assert.match(res.body.error, /Serial number 06001 is already claimed/);
  assert.equal(saved, undefined);
  assert.deepEqual(route.events, []);
});

test('rejects changing a draft to a serial number used by another entitlement', async () => {
  const route = createRoute([{ id: '1' }], undefined, [], true, true, true, undefined, {
    entitlements: [{ id: '123' }, { id: '100' }],
    entitlementDetails: {
      123: {
        id: '123',
        entState: 'DRAFT',
        eid: 'test-eid',
        startDate: '2026-11-10',
        products: [{
          productId: '60',
          memorySegments: [{ name: 'Serial Number', saot: true, text: '31373730' }],
        }],
      },
      100: {
        id: '100',
        products: [{
          productId: '60',
          memorySegments: [{ name: 'Serial Number', saot: true, text: '31373731' }],
        }],
      },
    },
  });
  const { res, saved } = await route.submit({}, true);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.error, /Serial number 06001 is already claimed/);
  assert.equal(saved, undefined);
});

test('serializes duplicate checks with concurrent entitlement creation', async () => {
  const route = createRoute([{ id: '1' }], undefined, [], true, true, true, undefined, {
    recordCreatedEntitlements: true,
  });
  const results = await Promise.all([route.submit(), route.submit()]);
  assert.deepEqual(results.map(({ res }) => res.statusCode).sort(), [201, 409],
    JSON.stringify(results.map(({ res }) => res.body)));
  assert.equal(route.events.filter((event) => event === 'create').length, 1);
});

test('increments serial after creating a draft but not after updating or failing to create', async () => {
  const route = createRoute([{ id: '1' }]);
  const result = await route.submit();
  assert.equal(result.res.statusCode, 201);
  assert.equal(result.res.body.serialNumber, 43);
  assert.equal(result.res.body.serialNumberUpdated, true);
  assert.deepEqual(route.events, ['create', 'get', 'set:43']);
  const edited = createRoute([{ id: '1' }], undefined, [], true, true, true, undefined, { serialContent: '31373730' });
  assert.equal((await edited.submit()).res.statusCode, 201);
  assert.deepEqual(edited.events, ['create', 'get', 'set:43']);
  const failed = createRoute([{ id: '1' }], undefined, [], true, true, true, undefined, { createError: true });
  assert.equal((await failed.submit()).res.statusCode, 502);
  assert.deepEqual(failed.events, ['create']);
  const counterFailure = createRoute([{ id: '1' }], undefined, [], true, true, true, undefined, { setError: true });
  const saved = await counterFailure.submit();
  assert.equal(saved.res.statusCode, 201);
  assert.equal(saved.res.body.saved, true);
  assert.equal(saved.res.body.serialNumberUpdated, false);
  assert.match(saved.res.body.serialNumberError, /serial write failed/);
  assert.deepEqual(counterFailure.events, ['create', 'get', 'set:43']);
  const update = createRoute([{ id: '1' }]);
  await update.submit({}, true);
  assert.deepEqual(update.events, []);
});

test('rejects invalid encoded serial numbers before creation', async () => {
  const route = createRoute([{ id: '1' }], undefined, [], true, true, true, undefined, { serialContent: 'FFFFFFFF' });
  assert.equal((await route.submit()).res.statusCode, 400);
  assert.deepEqual(route.events, []);
});

test('rejects new draft serials below 6,000 but permits 6,000', async () => {
  const tooSmall = await createRoute([{ id: '1' }]).submit({ serialTestContent: '30303546' });
  assert.equal(tooSmall.res.statusCode, 400);
  assert.match(tooSmall.res.body.error, /at least 6,000/);
  assert.deepEqual(tooSmall.res.body.saved, undefined);

  const minimum = await createRoute([{ id: '1' }]).submit({ serialTestContent: '31373730' });
  assert.equal(minimum.res.statusCode, 201);
});

test('forwards order code on creation and preserves it when editing', async () => {
  const create = await createRoute([{ id: '1' }]).submit({ refId1: 'ORDER-123' });
  assert.equal(create.res.statusCode, 201);
  assert.equal(create.saved.refId1, 'ORDER-123');
  for (const refId1 of [undefined, '', '   ']) {
    const blank = await createRoute([{ id: '1' }]).submit({ refId1 });
    assert.equal(blank.res.statusCode, 400);
    assert.match(blank.res.body.error, /Order Code.*required/);
    assert.equal(blank.saved, undefined);
  }
  const update = await createRoute([{ id: '1' }]).submit({}, true);
  assert.equal(update.res.statusCode, 200);
  assert.equal(update.saved.refId1, undefined);
  const clear = await createRoute([{ id: '1' }]).submit({ refId1: '' }, true);
  assert.equal(clear.saved.refId1, '');
  const tooLong = await createRoute([{ id: '1' }]).submit({ refId1: 'x'.repeat(251) });
  assert.equal(tooLong.res.statusCode, 400);
});

test('enforces entitlement description and order code limits', async () => {
  const valid = await createRoute([{ id: '1' }]).submit({ description: 'd'.repeat(510), refId1: 'r'.repeat(250) });
  assert.equal(valid.res.statusCode, 201);
  assert.equal(valid.saved.description.length, 510);
  assert.equal(valid.saved.refId1.length, 250);
  for (const values of [{ description: 'd'.repeat(511) }, { refId1: 'r'.repeat(251) }]) {
    const { res } = await createRoute([{ id: '1' }]).submit(values);
    assert.equal(res.statusCode, 400);
  }
});

test('entitlement creation always sends Sentinel LDK even if a different ID is supplied', async () => {
  for (const overrides of [{}, { enforcementId: '99' }]) {
    const { res, saved } = await createRoute([{ id: '1' }, { id: '99' }]).submit(overrides);
    assert.equal(res.statusCode, 201);
    assert.equal(saved.enforcementId, '1');
  }
});

test('lease requires the base expiry value and non-lease uses the EMS default', async () => {
  const memory = [{ kind: 'product', segments: [
    { id: '90', size: '4', name: 'Expiry Date', content: '00000000', saot: true },
  ] }];
  const route = () => createRoute([{ id: '1' }], new Date(2026, 10, 10, 12), memory);
  const noLease = await route().submit({
    productIds: ['6048'], memoryValues: [{ productId: '60', segmentId: '90', content: 'FFFFFFFF' }],
  });
  assert.equal(noLease.res.statusCode, 201);
  assert.equal(noLease.saved.memorySegments.find((segment) => segment.id === '90').content, '00000000');
  const missing = await route().submit({ productIds: ['6048', '6050'] });
  assert.equal(missing.res.statusCode, 400);
  const invalid = await route().submit({
    productIds: ['6048', '6050'], memoryValues: [{ productId: '60', segmentId: '90', content: 'invalid' }],
  });
  assert.equal(invalid.res.statusCode, 400);
  const valid = await route().submit({
    productIds: ['6048', '6050'], memoryValues: [{ productId: '60', segmentId: '90', content: '35463641' }],
  });
  assert.equal(valid.res.statusCode, 201);
  assert.equal(valid.saved.memorySegments[0].content, '35463641');
  assert.deepEqual(Array.from(valid.saved.productIds), ['60', '6048', '6050']);
  const absent = await createRoute([{ id: '1' }]).submit({ productIds: ['6048', '6050'] });
  assert.equal(absent.res.statusCode, 400);
  assert.match(absent.res.body.error, /Expiry Date/);
  const ambiguous = await createRoute([{ id: '1' }], new Date(), [{ kind: 'product', segments: [
    ...memory[0].segments, { id: '91', size: '4', name: 'Expiry Date', content: '00000000', saot: true },
  ] }]).submit({ productIds: ['6048', '6050'] });
  assert.equal(ambiguous.res.statusCode, 400);
  assert.match(ambiguous.res.body.error, /exactly one.*Expiry Date/);
  const invalidDefault = await createRoute([{ id: '1' }], new Date(), [{ kind: 'product', segments: [
    { ...memory[0].segments[0], content: '' },
  ] }]).submit();
  assert.equal(invalidDefault.res.statusCode, 400);
  assert.match(invalidDefault.res.body.error, /Expiry Date/);
  const noAccess = await route().submit({ productIds: ['6050'] });
  assert.equal(noAccess.res.statusCode, 400);
  assert.match(noAccess.res.body.error, /Standalone, Link/);
});

test('updating a non-lease draft without saved expiry memory uses the EMS default', async () => {
  const defaultExpiry = 'A1B2C3D4';
  for (const memorySegments of [[], [{ id: '90', text: '' }]]) {
    const route = createRoute([{ id: '1' }], new Date(2026, 10, 10, 12), [{
      kind: 'product',
      segments: [{ id: '90', size: '4', name: 'Expiry Date', content: defaultExpiry, saot: true }],
    }], true, true, true, undefined, {
      entitlementDetails: {
        123: {
          id: '123',
          entState: 'DRAFT',
          eid: 'test-eid',
          startDate: '2026-11-10',
          products: memorySegments.length ? [{ productId: '60', memorySegments }] : [],
        },
      },
    });
    const result = await route.submit({}, true);
    assert.equal(result.res.statusCode, 200);
    assert.equal(result.saved.memorySegments.find((segment) => segment.id === '90').content, defaultExpiry);
  }
});

test('rejects lease expiry dates outside the configured inclusive range', async () => {
  const memory = [{ kind: 'product', segments: [{ id: '90', size: '4', name: 'Expiry Date', saot: true }] }];
  const encode = (year, month, day) => {
    const digits = ((year - 1980) * 512 + month * 32 + day).toString(16).toUpperCase().padStart(4, '0');
    return Buffer.from(digits, 'ascii').toString('hex');
  };
  for (const [year, month, day, status] of [
    [2026, 11, 9, 400], [2027, 5, 9, 400], [2027, 5, 10, 201],
    [2028, 11, 10, 201], [2028, 11, 11, 400],
  ]) {
    const { res } = await createRoute([{ id: '1' }], new Date(2026, 10, 10, 12), memory).submit({
      productIds: ['6048', '6050'], startDate: '2026-11-10',
      memoryValues: [{ productId: '60', segmentId: '90', content: encode(year, month, day) }],
    });
    assert.equal(res.statusCode, status, `${year}-${month}-${day}`);
    if (status === 400) assert.match(res.body.error, /lease expiry date/i);
  }
  const updateRoute = () => createRoute([{ id: '1' }], new Date(2027, 5, 1, 12), memory, true, true, true, '2026-01-01');
  for (const [year, month, day, status] of [
    [2027, 5, 31, 400], [2027, 6, 1, 200], [2028, 1, 1, 200], [2028, 1, 2, 400],
  ]) {
    const { res } = await updateRoute().submit({
      productIds: ['6048', '6050'], startDate: '2027-06-01',
      memoryValues: [{ productId: '60', segmentId: '90', content: encode(year, month, day) }],
    }, true);
    assert.equal(res.statusCode, status, `update ${year}-${month}-${day}`);
  }
});

test('unavailable Lease does not prevent creation without it', async () => {
  const route = () => createRoute([{ id: '1' }], new Date(), [], true, false);
  assert.equal((await route().submit({ productIds: ['6048'] })).res.statusCode, 201);
  assert.equal((await route().submit({ productIds: ['6048', '6050'] })).res.statusCode, 400);
});

test('version selection forwards the modification and rejects an unavailable version', async () => {
  const normal = await createRoute([{ id: '1' }]).submit();
  assert.deepEqual(Array.from(normal.saved.productIds), ['60', '6048']);
  const selected = await createRoute([{ id: '1' }]).submit({ productIds: ['6048', '6052'] });
  assert.equal(selected.res.statusCode, 201);
  assert.deepEqual(Array.from(selected.saved.productIds), ['60', '6048', '6052']);
  const route = () => createRoute([{ id: '1' }], new Date(), [], true, true, false);
  assert.equal((await route().submit()).res.statusCode, 201);
  assert.equal((await route().submit({ productIds: ['6048', '6052'] })).res.statusCode, 400);
});

test('unavailable optional Pivot does not prevent creation without it', async () => {
  const route = () => createRoute([{ id: '1' }], new Date(2026, 10, 10, 12), [], false);
  assert.equal((await route().submit({ productIds: ['6048'] })).res.statusCode, 201);
  assert.equal((await route().submit({ productIds: ['6048', '6051'] })).res.statusCode, 400);
});

test('uses the submitted date or server UTC fallback and always creates a never-expiring entitlement', async () => {
  const localClock = new Date(2026, 10, 12, 0, 30, 0, 123);
  for (const overrides of [
    {},
    { startDate: '2000-01-01' },
    { endDate: '2026-11-11', neverExpires: false },
    { endDate: '', neverExpires: false },
  ]) {
    const { res, saved } = await createRoute([{ id: '1' }], localClock).submit(overrides);
    assert.equal(res.statusCode, 201);
    assert.equal(saved.startDate, overrides.startDate || localClock.toISOString().slice(0, 10));
    assert.equal(saved.createDate, '2026-11-12T00:30:00.123' +
      `${-localClock.getTimezoneOffset() >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(localClock.getTimezoneOffset()) / 60)).padStart(2, '0')}:${String(Math.abs(localClock.getTimezoneOffset()) % 60).padStart(2, '0')}`);
    assert.equal(saved.endDate, '2500-12-31');
  }
});

test('defaults the start date to UTC on either side of local midnight', async () => {
  const originalTimezone = process.env.TZ;
  try {
    for (const [timezone, instant, expected, localDate] of [
      ['Pacific/Auckland', '2026-11-11T11:30:00Z', '2026-11-11', 12],
      ['America/Los_Angeles', '2026-11-12T00:30:00Z', '2026-11-12', 11],
    ]) {
      process.env.TZ = timezone;
      const clock = new Date(instant);
      assert.equal(clock.getDate(), localDate);
      const { res, saved } = await createRoute([{ id: '1' }], clock).submit();
      assert.equal(res.statusCode, 201);
      assert.equal(saved.startDate, expected);
      const expiry = timezone === 'Pacific/Auckland' ? '2027-05-11' : '2027-05-12';
      const [year, month, day] = expiry.split('-').map(Number);
      const digits = ((year - 1980) * 512 + month * 32 + day).toString(16).toUpperCase().padStart(4, '0');
      const memory = [{ kind: 'product', segments: [{ id: '90', size: '4', name: 'Expiry Date', saot: true }] }];
      const leased = await createRoute([{ id: '1' }], clock, memory).submit({
        productIds: ['6048', '6050'],
        memoryValues: [{ productId: '60', segmentId: '90', content: Buffer.from(digits, 'ascii').toString('hex') }],
      });
      assert.equal(leased.res.statusCode, 201);
      assert.equal(leased.saved.startDate, expected);
    }
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});

test('rejects invalid submitted start dates', async () => {
  for (const startDate of ['2026-2-03', '2025-02-29', '2026-13-01', '2026-11-12T00:00:00Z']) {
    const { res, saved } = await createRoute([{ id: '1' }]).submit({ startDate });
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /valid calendar date/);
    assert.equal(saved, undefined);
  }
});

test('entitlement creation reports missing Sentinel LDK enforcement', async () => {
  const { res, saved } = await createRoute([{ id: '99' }]).submit();
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Sentinel LDK enforcement \(1\)/);
  assert.equal(saved, undefined);
});

test('entitlement creation always uses Product Key with one key and one activation', async () => {
  for (const overrides of [
    {},
    { lineItemType: 'Hardware_Key' },
    { lineItemType: 'ProtectionKey_Update' },
    { numberOfKeys: 0, activationsPerKey: 99 },
    { numberOfKeys: 1000000, activationsPerKey: 0 },
  ]) {
    const { res, saved } = await createRoute([{ id: '1' }]).submit(overrides);
    assert.equal(res.statusCode, 201);
    assert.equal(saved.lineItemType, 'Product_Key');
    assert.equal(saved.numberOfKeys, 1);
    assert.equal(saved.activationsPerKey, 1);
  }
});

test('requires Link or Standalone and includes the base product', async () => {
  for (const productIds of [['6048'], ['6049'], ['6048', '6049'], ['6049', '12'], ['6048', '6051']]) {
    const { res, saved } = await createRoute([{ id: '1' }]).submit({ productIds });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(Array.from(saved.productIds), ['60', ...productIds]);
  }
  for (const productIds of [[], ['12'], ['6051'], ['60'], ['13'], ['99'], ['6048', '6048']]) {
    const { res, saved } = await createRoute([{ id: '1' }]).submit({ productIds });
    assert.equal(res.statusCode, 400);
    assert.equal(saved, undefined);
  }
});

test('requires and forwards the automatically included base product SAOT values', async () => {
  const baseMemory = [{ kind: 'product', segments: [{ id: '90', size: '2', name: 'Serial', saot: true }] }];
  const route = () => createRoute([{ id: '1' }], new Date(2026, 10, 10, 12), baseMemory);
  const missing = await route().submit({ productIds: ['6048'] });
  assert.equal(missing.res.statusCode, 400);
  assert.match(missing.res.body.error, /every SAOT/);
  const valid = await route().submit({
    productIds: ['6048'], memoryValues: [{ productId: '60', segmentId: '90', content: '00ab' }],
  });
  assert.equal(valid.res.statusCode, 201);
  assert.equal(valid.saved.memorySegments[0].id, '90');
  assert.equal(valid.saved.memorySegments[0].content, '00AB');
});
