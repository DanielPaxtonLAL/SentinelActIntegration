const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function activationsRoute() {
  let handler;
  const calls = [];
  class EmsClient {
    constructor() {
      this.authenticated = true;
      this.cookies = new Map();
    }
    async listEntitlements() {
      return [
        { id: '1', state: 'PRODUCT_KEY_GENERATED', customer: 'Acme' },
        { id: '2', state: 'DRAFT', customer: 'Draft customer' },
      ];
    }
    async getEntitlementProductKeys(id) {
      calls.push(['keys', id]);
      return id === '1' ? [
        { productKeyId: 'key-001', entitlementId: id, customerName: 'Acme', activationIds: ['aid-001', 'aid-002'] },
        { productKeyId: 'key-002', entitlementId: id, customerName: 'Acme', activationIds: ['aid-001'] },
      ] : [];
    }
    async getActivationLicense(aid) {
      calls.push(['activation', aid]);
      return { aid, protectionKeyId: 'pk-' + aid, activationString: 'license' };
    }
  }
  const app = {
    get(route, ...handlers) {
      if (route === '/api/activations') handler = handlers.at(-1);
    },
    post() {},
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
    console,
  });
  return async () => {
    const res = {
      statusCode: 200,
      set() { return this; },
      status(code) { this.statusCode = code; return this; },
      json(data) { this.body = data; return this; },
    };
    await handler({ ems: new EmsClient() }, res);
    return { res, calls };
  };
}

test('lists distinct activations for generated product keys only', async () => {
  const load = activationsRoute();
  const { res, calls } = await load();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Array.from(res.body, (activation) => [activation.aid, activation.productKeyId, activation.customerName]), [
    ['aid-001', 'key-001', 'Acme'],
    ['aid-002', 'key-001', 'Acme'],
  ]);
  assert.deepEqual(calls, [
    ['keys', '1'],
    ['activation', 'aid-001'],
    ['activation', 'aid-002'],
  ]);
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
