const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const formJson = {
  'base-product-id': '60',
  'lease-expiry-range': { 'min-months': 6, 'max-months': 24 },
  'product-options': { standalone: { label: 'Standalone', 'product-id': '6048' }, link: { label: 'Link', 'product-id': '6049' } },
  'optional-products': { pivot: { label: 'Pivot', 'product-id': '6051' } },
  version: { v22: { label: 'Version 22', 'product-id': '' }, v23: { label: 'Version 23', 'product-id': '6052' } },
  lease: { lease: { label: 'Lease', 'product-id': '6050' } },
};

function createRoute(enforcements, clock = new Date(2026, 10, 10, 12), baseMemory = [], pivotAvailable = true, leaseAvailable = true, versionAvailable = true, existingStartDate = '2026-11-10') {
  let handler;
  let updateHandler;
  let saved;
  class EmsClient {
    constructor() { this.authenticated = true; }
    async listCustomers() { return [{ customerId: '5' }]; }
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
    async getProductReadOnlyMemory(id) { return String(id) === '60' ? baseMemory : []; }
    async createEntitlement(data) { saved = data; return { saved: true }; }
    async getEntitlementDetails() { return { entState: 'DRAFT', eid: 'test-eid', refId1: '00123', startDate: existingStartDate }; }
    async updateEntitlement(_id, data) { saved = data; return { saved: true }; }
  }
  const app = {
    get() {},
    post(route, ...handlers) { if (route === '/api/entitlements') handler = handlers.at(-1); },
    put(route, ...handlers) { if (route === '/api/entitlements/:id') updateHandler = handlers.at(-1); },
    delete() {},
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
    if (name === './entitlement-memory') return require('../entitlement-memory');
    if (name === './entitlement-form-data') return { loadFormData: () => require('../entitlement-form-data').parseFormData(formJson) };
    if (name === './public/lease-dates') return require('../public/lease-dates');
    if (name === './page-includes') return require('../page-includes');
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), {
    require: customRequire,
    __dirname: root,
    process: { env: { EMS_URL: 'https://ems.example', EMS_USER: 'test', EMS_PASS: 'test' } },
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [clock.getTime()])); }
    },
    console,
  });
  return {
    async submit(overrides = {}, update = false) {
      const req = { params: update ? { id: '123' } : undefined, body: {
        customerId: '5', productIds: ['6048'],
        description: '', ...overrides,
      } };
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

test('forwards order code on creation and preserves it when editing', async () => {
  const create = await createRoute([{ id: '1' }]).submit({ refId1: 'ORDER-123' });
  assert.equal(create.res.statusCode, 201);
  assert.equal(create.saved.refId1, 'ORDER-123');
  const blank = await createRoute([{ id: '1' }]).submit();
  assert.equal(blank.saved.refId1, '');
  const update = await createRoute([{ id: '1' }]).submit({}, true);
  assert.equal(update.res.statusCode, 200);
  assert.equal(update.saved.refId1, '00123');
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
  assert.equal(noLease.saved.memorySegments[0].content, '00000000');
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
      productIds: ['6048', '6050'],
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

test('uses the submitted local date or server local fallback and always creates a never-expiring entitlement', async () => {
  const localClock = new Date(2026, 10, 12, 0, 30, 0, 123);
  for (const overrides of [
    {},
    { startDate: '2000-01-01' },
    { endDate: '2026-11-11', neverExpires: false },
    { endDate: '', neverExpires: false },
  ]) {
    const { res, saved } = await createRoute([{ id: '1' }], localClock).submit(overrides);
    assert.equal(res.statusCode, 201);
    assert.equal(saved.startDate, overrides.startDate || '2026-11-12');
    assert.equal(saved.createDate, '2026-11-12T00:30:00.123' +
      `${-localClock.getTimezoneOffset() >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(localClock.getTimezoneOffset()) / 60)).padStart(2, '0')}:${String(Math.abs(localClock.getTimezoneOffset()) % 60).padStart(2, '0')}`);
    assert.equal(saved.endDate, '2500-12-31');
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
