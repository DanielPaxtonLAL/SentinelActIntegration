const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function activationsRoute({ c2vError, logger = console } = {}) {
  let handler;
  let pendingUpdatesHandler;
  const calls = [];
  class EmsClient {
    constructor() {
      this.authenticated = true;
      this.cookies = new Map();
    }
    async listEntitlementsForActivations() {
      return [
        { id: '1', state: 'PRODUCT_KEY_GENERATED', customer: 'Acme' },
        { id: '2', state: 'COMPLETED', customer: 'Other customer' },
        { id: '3', state: 'DRAFT', customer: 'Draft customer' },
      ];
    }
    async getProductKeysForActivations(id) {
      calls.push(['keys', id]);
      return id === '1' ? [
        { productKeyId: 'key-001', entitlementId: id, customerName: 'Acme', totalEntitled: '2', available: '0', activationIds: ['aid-001', 'aid-002'] },
        { productKeyId: 'key-006', entitlementId: id, customerName: 'Acme', totalEntitled: '1', available: '0', activationIds: ['aid-001'] },
      ] : id === '2' ? [
        { productKeyId: 'key-002', entitlementId: id, totalEntitled: '1', available: '0', activationIds: ['aid-003'] },
        { productKeyId: 'key-003', entitlementId: id, totalEntitled: '1', available: '0', activationIds: [] },
        { productKeyId: 'key-004', entitlementId: id, totalEntitled: '1', available: '1', activationIds: [] },
        { productKeyId: 'key-005', entitlementId: id, activationIds: [] },
      ] : [];
    }
    async getActivationLicense(aid) {
      calls.push(['activation', aid]);
      return { aid, protectionKeyId: 'pk-' + aid, activationString: 'license' };
    }
    async getActivationC2V(aid) {
      calls.push(['stored-c2v', aid]);
      if (c2vError) throw c2vError;
      return '<hasp_info><haspscope/><c2v>YWJj</c2v></hasp_info>';
    }
    async fetchPendingUpdates(c2v) {
      calls.push(['pending-updates', c2v]);
      return '<hasp_info><v2cp>YWJj</v2cp></hasp_info>';
    }
  }
  const app = {
    get(route, ...handlers) {
      if (route === '/api/activations') handler = handlers.at(-1);
    },
    post(route, ...handlers) {
      if (route === '/api/activations/:aid/pending-updates') pendingUpdatesHandler = handlers.at(-1);
    },
    put() {},
    delete() {},
    use() {},
    listen() {},
  };
  const express = () => app;
  express.static = express.json = () => {};
  const root = path.join(__dirname, '..');
  const customRequire = (name) => {
    if (name === 'express') return express;
    if (name === 'fs') return { existsSync: () => false, watch() {} };
    if (name === './ems-client') return { EmsClient };
    if (name === './act-client') return { ActClient: class {} };
    if (name === './entitlement-form-data') return { loadFormData: () => ({}) };
    if (name.startsWith('.')) return require(path.resolve(root, 'src', name));
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8'), {
    require: customRequire,
    __dirname: path.join(root, 'src'),
    process: { argv: ['node', 'server.js'], env: { IS_TEST_MODE: 'false', PRODUCTION_EMS_URL: 'https://ems.example', ACT_URL: 'https://act.example' } },
    console: logger,
  });
  const invoke = async (handlerToCall, params = {}) => {
    const res = {
      statusCode: 200,
      set() { return this; },
      status(code) { this.statusCode = code; return this; },
      json(data) { this.body = data; return this; },
    };
    await handlerToCall({ params, ems: new EmsClient() }, res);
    return { res, calls };
  };
  return {
    load: () => invoke(handler),
    pendingUpdates: (aid) => invoke(pendingUpdatesHandler, { aid }),
  };
}

test('lists activations and keys without IDs regardless of entitlement counts', async () => {
  const route = activationsRoute();
  const { res, calls } = await route.load();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Array.from(res.body.activations, (activation) => [activation.aid, activation.productKeyId, activation.customerName]), [
    ['aid-001', 'key-001', 'Acme'],
    ['aid-002', 'key-001', 'Acme'],
    ['aid-001', 'key-006', 'Acme'],
    ['aid-003', 'key-002', 'Other customer'],
    [null, 'key-003', 'Other customer'],
    [null, 'key-004', 'Other customer'],
    [null, 'key-005', 'Other customer'],
  ]);
  assert.equal(res.body.activations[4].activationString, null);
  assert.deepEqual(calls, [
    ['keys', '1'],
    ['keys', '2'],
    ['keys', '3'],
    ['activation', 'aid-001'],
    ['activation', 'aid-002'],
    ['activation', 'aid-003'],
  ]);
});

test('fetches V2CP using the C2V saved with the activation', async () => {
  const route = activationsRoute();
  const { res, calls } = await route.pendingUpdates('aid-001');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.package, '<hasp_info><v2cp>YWJj</v2cp></hasp_info>');
  assert.deepEqual(calls, [
    ['stored-c2v', 'aid-001'],
    ['pending-updates', '<hasp_info><haspscope/><c2v>YWJj</c2v></hasp_info>'],
  ]);
});

test('logs the invalid C2V and diagnostics without returning its contents to the browser', async () => {
  const logged = [];
  const c2vError = Object.assign(new Error('Invalid saved C2V'), {
    c2vDiagnostic: { format: 'text', xmlError: 'InvalidChar', line: 1, column: 39 },
    c2vValue: '<?xml version="1.0" encoding="UTF-8"?>&#xd;<hasp_info/>',
  });
  const route = activationsRoute({ c2vError, logger: { error: (...args) => logged.push(args) } });
  const { res, calls } = await route.pendingUpdates('aid-001');
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'Invalid saved C2V');
  assert.deepEqual(logged, [
    ['Invalid saved C2V'],
    ['Saved C2V diagnostic:', '{"format":"text","xmlError":"InvalidChar","line":1,"column":39}'],
    ['Invalid saved C2V value:', c2vError.c2vValue],
    ['C2V at error position:', JSON.stringify(c2vError.c2vValue.slice(26, 51))],
  ]);
  assert.deepEqual(calls, [['stored-c2v', 'aid-001']]);
});

test('activations page provides a V2C download for an existing license', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'activations.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'pages', 'activations.js'), 'utf8');
  let definition;
  vm.runInNewContext(script, {
    Vue: { createApp: (options) => { definition = options; return { mount() {} }; } },
  });
  const license = '<hasp_info><v2c>YWJj</v2c></hasp_info>';
  assert.equal(definition.methods.licenseDownloadUrl(license), 'data:application/xml;charset=utf-8,' + encodeURIComponent(license));
  assert.match(html, /:download="'Activation-' \+ activation\.aid\.replace/);
});

test('activations page loads keys without IDs and disables unavailable V2CP requests', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'activations.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'pages', 'activations.js'), 'utf8');
  let definition;
  vm.runInNewContext(script, {
    fetch: async (url) => {
      assert.equal(url, '/api/activations');
      return { ok: true, json: async () => ({ activations: [{ aid: null, productKeyId: 'key-1' }] }) };
    },
    Vue: { createApp: (options) => { definition = options; return { mount() {} }; } },
  });
  const app = definition.data();
  await definition.methods.loadActivations.call(app);
  assert.equal(app.activations[0].productKeyId, 'key-1');
  assert.equal(app.activations[0].aid, null);
  assert.match(html, /No activation ID returned; license unavailable/);
  assert.match(html, /No activation record to retrieve a saved C2V/);
  assert.doesNotMatch(html, /missingActivationIds/);
});

test('fetches V2CP for the chosen activation and surfaces EMS errors', async () => {
  const root = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(root, 'activations.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'pages', 'activations.js'), 'utf8');
  let definition;
  let calls = 0;
  let fail = false;
  const v2cp = '<hasp_info><v2cp>YWJj</v2cp></hasp_info>';
  vm.runInNewContext(script, {
    fetch: async (url, options) => {
      calls++;
      assert.equal(url, '/api/activations/aid-1/pending-updates');
      assert.equal(options.method, 'POST');
      assert.equal(options.cache, 'no-store');
      return fail
        ? { ok: false, json: async () => ({ error: 'EMS returned 404' }) }
        : { ok: true, json: async () => ({ package: v2cp }) };
    },
    Vue: { createApp: (options) => { definition = options; return { mount() {} }; } },
  });
  const first = { aid: 'aid-1', productKeyId: 'key-001' };
  const other = { productKeyId: 'key-002' };
  await definition.methods.fetchPendingUpdates.call({}, first);
  assert.equal(first.pendingUpdate.package, v2cp);
  assert.equal(first.pendingUpdate.loading, false);
  assert.equal(other.pendingUpdate, undefined);
  assert.match(html, /@click="fetchPendingUpdates\(activation\)"/);
  assert.match(html, /:disabled="!activation\.aid \|\| activation\.pendingUpdate\?\.loading"/);
  assert.match(html, /Download V2CP/);
  assert.match(html, /C2V saved by EMS for the activation/);
  assert.equal(calls, 1);
  await definition.methods.fetchPendingUpdates.call({}, other);
  assert.equal(calls, 1);
  assert.equal(other.pendingUpdate, undefined);
  fail = true;
  await definition.methods.fetchPendingUpdates.call({}, first);
  assert.match(first.pendingUpdate.error, /404/);
  assert.equal(first.pendingUpdate.package, '');
});
