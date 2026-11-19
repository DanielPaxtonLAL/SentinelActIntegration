const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { getEmsConfig, getEmsConfigForUrl } = require('../ems-config');

const env = {
  IS_TEST_MODE: 'false',
  PRODUCTION_EMS_URL: 'https://production.example',
  PRODUCTION_EMS_INSECURE: '1',
  PRODUCTION_EMS_API_VERSION: 'v90',
  PRODUCTION_EMS_USER_TYPE: 'ISV',
  TEST_EMS_URL: 'https://test.example',
  TEST_EMS_INSECURE: '0',
  TEST_EMS_API_VERSION: 'v91',
  TEST_EMS_USER_TYPE: 'CUSTOMER',
  ACT_URL: 'https://act.example',
};

test('requires an explicit valid mode, selected URL, and valid TLS flag', () => {
  assert.throws(() => getEmsConfig({ ...env, IS_TEST_MODE: 'yes' }), /IS_TEST_MODE/);
  assert.throws(() => getEmsConfig({ ...env, IS_TEST_MODE: undefined }), /IS_TEST_MODE/);
  assert.throws(() => getEmsConfig({ ...env, TEST_EMS_URL: '', IS_TEST_MODE: 'true' }), /TEST_EMS_URL/);
  assert.throws(() => getEmsConfig({ ...env, PRODUCTION_EMS_INSECURE: 'yes' }), /PRODUCTION_EMS_INSECURE/);
});

test('explicit helper URLs use their matching environment independently of the selected mode', () => {
  assert.equal(getEmsConfigForUrl(env, 'https://test.example/').apiVersion, 'v91');
  assert.equal(getEmsConfigForUrl({ ...env, IS_TEST_MODE: 'true' }, 'https://production.example').insecure, true);
  assert.equal(getEmsConfigForUrl(env, 'https://other.example'), null);
  assert.throws(() => getEmsConfigForUrl({ ...env, TEST_EMS_URL: env.PRODUCTION_EMS_URL }, env.PRODUCTION_EMS_URL), /URLs must be different/);
});

test('mode arguments override the environment and reject invalid or conflicting arguments', () => {
  assert.equal(getEmsConfig(env, ['--test']).isTestMode, true);
  assert.equal(getEmsConfig({ ...env, IS_TEST_MODE: 'true' }, ['--production']).isTestMode, false);
  assert.equal(getEmsConfig({ ...env, IS_TEST_MODE: undefined }, ['--test']).isTestMode, true);
  assert.throws(() => getEmsConfig(env, ['--testing']), /--test or --production/);
  assert.throws(() => getEmsConfig(env, ['--test', '--production']), /--test or --production/);
});

test('the server uses matching connection settings and product IDs for each mode', async () => {
  const production = { emsMode: 'production', url: 'https://production.example', insecure: true, apiVersion: 'v90', userType: 'ISV' };
  const testMode = { emsMode: 'test', url: 'https://test.example', insecure: false, apiVersion: 'v91', userType: 'CUSTOMER' };
  for (const [mode, args, expected] of [
    ['false', [], production],
    ['true', [], testMode],
    ['false', ['--test'], testMode],
    ['true', ['--production'], production],
  ]) {
    const routes = new Map();
    const app = {
      get(route, ...handlers) { routes.set(`GET ${route}`, handlers.at(-1)); },
      post(route, ...handlers) { routes.set(`POST ${route}`, handlers.at(-1)); },
      put() {}, delete() {}, use() {}, listen() {},
    };
    const express = () => app;
    express.static = express.json = () => {};
    let productMode;
    let clientOptions;
    class EmsClient {
      constructor(options) { clientOptions = options; }
      async authenticate() { this.authenticated = true; }
    }
    class ActClient { async authenticate() {} }
    const root = path.join(__dirname, '..');
    const customRequire = (name) => {
      if (name === 'express') return express;
      if (name === 'fs') return { existsSync: () => false, watch() {} };
      if (name === './ems-client') return { EmsClient };
      if (name === './act-client') return { ActClient };
      if (name === './entitlement-form-data') return { loadFormData(_file, isTestMode) { productMode = isTestMode; return {}; } };
      if (name.startsWith('./')) return require(path.join(root, name));
      return require(name);
    };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), {
      require: customRequire, __dirname: root, process: { argv: ['node', 'server.js', ...args], env: { ...env, IS_TEST_MODE: mode } }, console,
    });
    const res = () => ({
      statusCode: 200,
      set() { return this; },
      status(code) { this.statusCode = code; return this; },
      json(data) { this.body = data; return this; },
      cookie() {},
    });
    assert.equal(productMode, expected.emsMode === 'test');
    const session = res();
    routes.get('GET /api/session')({ headers: {} }, session);
    assert.equal(session.body.emsMode, expected.emsMode);
    const body = { username: 'ems', password: 'pass', actUsername: 'act', actPassword: 'pass' };
    const stale = res();
    await routes.get('POST /api/login')({ headers: {}, body: { ...body, emsMode: expected.emsMode === 'test' ? 'production' : 'test' } }, stale);
    assert.equal(stale.statusCode, 409);
    assert.equal(clientOptions, undefined);
    const login = res();
    await routes.get('POST /api/login')({ headers: {}, body: { ...body, emsMode: expected.emsMode } }, login);
    assert.equal(login.statusCode, 200);
    assert.equal(clientOptions.baseUrl, expected.url);
    assert.equal(clientOptions.insecure, expected.insecure);
    assert.equal(clientOptions.apiVersion, expected.apiVersion);
    assert.equal(clientOptions.userType, expected.userType);
  }
});
