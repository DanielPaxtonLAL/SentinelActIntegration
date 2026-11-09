const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createRoute(enforcements, clock = new Date(2026, 10, 10, 12)) {
  let handler;
  let saved;
  class EmsClient {
    constructor() { this.authenticated = true; }
    async listCustomers() { return [{ customerId: '5' }]; }
    async listCatalog() { return [{ productId: '12', lifeCycleStage: '2' }]; }
    async listEnforcements() { return enforcements; }
    async getProductReadOnlyMemory() { return []; }
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
        customerId: '5', productIds: ['12'],
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
