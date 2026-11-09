const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createRoute(enforcements, clock = new Date(2026, 10, 10, 12), baseMemory = []) {
  let handler;
  let saved;
  class EmsClient {
    constructor() { this.authenticated = true; }
    async listCustomers() { return [{ customerId: '5' }]; }
    async findBaseProductByIdentifier(identifier) {
      assert.equal(identifier, '12345');
      return { id: '60', lifeCycleStage: 'Commit' };
    }
    async listModificationProducts(id) {
      assert.equal(id, '60');
      return [{ productId: '6048', productName: '01 ADD Standalone', lifeCycleStage: 'Commit' },
        { productId: '6049', productName: '02 ADD Link', lifeCycleStage: 'Commit' },
        { productId: '12', productName: 'Modification', lifeCycleStage: 'Commit' },
        { productId: '13', productName: 'Draft', lifeCycleStage: 'Draft' }];
    }
    async listEnforcements() { return enforcements; }
    async getProductReadOnlyMemory(id) { return String(id) === '60' ? baseMemory : []; }
    async createEntitlement(data) { saved = data; return { saved: true }; }
  }
  const app = {
    get() {},
    post(route, ...handlers) { if (route === '/api/entitlements') handler = handlers.at(-1); },
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
    async submit(overrides = {}) {
      const req = { body: {
        customerId: '5', productIds: ['6048'],
        description: '', ...overrides,
      } };
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(data) { this.body = data; return this; },
      };
      await handler(req, res);
      return { res, saved };
    },
  };
}

test('entitlement creation always sends Sentinel LDK even if a different ID is supplied', async () => {
  for (const overrides of [{}, { enforcementId: '99' }]) {
    const { res, saved } = await createRoute([{ id: '1' }, { id: '99' }]).submit(overrides);
    assert.equal(res.statusCode, 201);
    assert.equal(saved.enforcementId, '1');
  }
});

test('uses the server local date and always creates a never-expiring entitlement', async () => {
  for (const overrides of [
    {},
    { startDate: '2000-01-01' },
    { endDate: '2026-11-11', neverExpires: false },
    { endDate: '', neverExpires: false },
  ]) {
    const { res, saved } = await createRoute([{ id: '1' }]).submit(overrides);
    assert.equal(res.statusCode, 201);
    assert.equal(saved.startDate, '2026-11-10');
    assert.equal(saved.endDate, '2500-12-31');
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
  for (const productIds of [['6048'], ['6049'], ['6048', '6049'], ['6049', '12']]) {
    const { res, saved } = await createRoute([{ id: '1' }]).submit({ productIds });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(Array.from(saved.productIds), ['60', ...productIds]);
  }
  for (const productIds of [[], ['12'], ['60'], ['13'], ['99'], ['6048', '6048']]) {
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
