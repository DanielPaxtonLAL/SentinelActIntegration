const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const AdmZip = require('adm-zip');
const { XMLParser } = require('fast-xml-parser');
const { buildHistoryV2cp } = require('../src/v2cp-package');

function v2c(key = '12345', vendor = '42', payload = 'YWJj') {
  return `<hasp_info><haspscope><vendor id="${vendor}"><hasp id="${key}"/></vendor></haspscope><v2c>${payload}</v2c></hasp_info>`;
}

function activationsRoute({ c2vError, logger = console, validHistory = false, updateDetailsError, associatedIds, invalidUpdateDetails = false } = {}) {
  let handler;
  let pendingUpdatesHandler;
  let historyHandler;
  let historyPackageHandler;
  let keyEntitlementsHandler;
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
      if (validHistory) return { aid, protectionKeyId: '12345', activationString: v2c('12345', '42', aid === 'history-base' ? 'YWJj' : 'ZGVm') };
      if (aid.startsWith('history-')) return {
        aid, protectionKeyId: aid === 'history-other' ? '999' : '12345', activationString: 'license-' + aid,
      };
      return { aid, protectionKeyId: 'pk-' + aid, activationString: 'license' };
    }
    async getProtectionKeyEntitlements(id) {
      calls.push(['entitlements', id]);
      if (associatedIds) return associatedIds;
      if (validHistory) return ['10'];
      return ['10', '20'];
    }
    async getEntitlementDetails(id) {
      calls.push(['details', id]);
      if (updateDetailsError) throw updateDetailsError;
      if (invalidUpdateDetails) return { id, lineItemTypes: [] };
      return id === '10'
        ? { id, lineItemTypes: ['Product_Key'], entState: 'COMPLETED' }
        : { id, lineItemTypes: ['ProtectionKey_Update'], entState: 'DRAFT', refId1: '00123' };
    }
    async getProtectionKeyActivationCandidates(id) {
      calls.push(['history-keys', id]);
      if (validHistory) return { keys: [{
        productKeyId: 'base',
        activationIds: ['history-update', 'history-base'],
        activationReferences: [
          { aid: 'history-update', protectionKeyId: '12345' },
          { aid: 'history-base', protectionKeyId: '12345' },
        ],
      }], missingUpdateProductKey: false };
      return id === '10' ? { keys: [{
        productKeyId: 'base',
        activationIds: ['history-base', 'history-other', 'history-unknown', 'history-conflict'],
        activationReferences: [
          { aid: 'history-base', protectionKeyId: '12345' },
          { aid: 'history-other', protectionKeyId: '999' },
          { aid: 'history-unknown', protectionKeyId: null },
          { aid: 'history-conflict', protectionKeyId: '12345' },
          { aid: 'history-conflict', protectionKeyId: '999' },
        ],
      }], missingUpdateProductKey: false } :
        { keys: [{
          productKeyId: 'update', activationIds: ['history-update'],
          activationReferences: [{ aid: 'history-update', protectionKeyId: '12345' }],
        }, { productKeyId: 'missing', activationIds: [], activationReferences: [] }], missingUpdateProductKey: true };
    }
    async getActivationUpdateCounter(id, aid) {
      calls.push(['counter', id, aid]);
      if (validHistory) return aid === 'history-base' ? '0' : '1';
      if (aid === 'history-update') throw new Error('EMS key history lookup failed: HTTP 404.');
      return '4';
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
      if (route === '/api/protection-keys/:id/activations') historyHandler = handlers.at(-1);
      if (route === '/api/protection-keys/:id/entitlements') keyEntitlementsHandler = handlers.at(-1);
      if (route === '/api/protection-keys/:id/v2cp') historyPackageHandler = handlers.at(-1);
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
    history: (id) => invoke(historyHandler, { id }),
    keyEntitlements: (id) => invoke(keyEntitlementsHandler, { id }),
    historyPackage: (id) => invoke(historyPackageHandler, { id }),
    pendingUpdates: (aid) => invoke(pendingUpdatesHandler, { aid }),
  };
}

test('lists only update entitlements associated with the requested protection key', async () => {
  const { res, calls } = await activationsRoute().keyEntitlements('12345');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Array.from(res.body, (entry) => [entry.id, entry.type, entry.state, entry.refId1]),
    [['20', 3, 'DRAFT', '00123']]);
  assert.deepEqual(calls, [['entitlements', '12345'], ['details', '10'], ['details', '20']]);
  const invalid = await activationsRoute().keyEntitlements('bad/id');
  assert.equal(invalid.res.statusCode, 400);
  assert.equal(invalid.calls.length, 0);
  const failure = await activationsRoute({ updateDetailsError: new Error('lookup failed'), logger: { error() {} } }).keyEntitlements('12345');
  assert.equal(failure.res.statusCode, 502);
  assert.match(failure.res.body.error, /lookup failed/);
  const empty = await activationsRoute({ associatedIds: [] }).keyEntitlements('12345');
  assert.equal(empty.res.statusCode, 200);
  assert.equal(empty.res.body.length, 0);
  const malformed = await activationsRoute({ invalidUpdateDetails: true, logger: { error() {} } }).keyEntitlements('12345');
  assert.equal(malformed.res.statusCode, 502);
  assert.match(malformed.res.body.error, /line item types/);
});

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

test('history discovers update licenses, filters other keys and reports missing IDs and counters', async () => {
  const route = activationsRoute({ logger: { error() {} } });
  const { res, calls } = await route.history('12345');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Array.from(res.body.activations, (item) => [item.aid, item.productKeyId, item.updateCounter]), [
    ['history-base', 'base', '4'],
    ['history-update', 'update', null],
  ]);
  assert.match(res.body.activations[1].counterError, /404/);
  assert.equal(res.body.activations[1].activationString, 'license-history-update');
  assert.equal(res.body.warnings.length, 5);
  assert.equal(calls.some((call) => call[0] === 'activation' &&
    ['history-other', 'history-unknown', 'history-conflict'].includes(call[1])), false);
  assert.equal(calls.some((call) => call[0] === 'counter' && call[2] === 'history-other'), false);
  assert.equal((await route.history('invalid/key')).res.statusCode, 400);
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

test('logs invalid C2V diagnostics without exposing its contents', async () => {
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
  ]);
  assert.deepEqual(calls, [['stored-c2v', 'aid-001']]);
});

test('activations page loads keys without IDs and disables V2CP without a protection key', async () => {
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
  app.groupKeys = definition.methods.groupKeys;
  app.selectKey = definition.methods.selectKey;
  await definition.methods.loadActivations.call(app);
  assert.equal(app.activations[0].productKeyId, 'key-1');
  assert.equal(app.activations[0].aid, null);
  assert.match(html, /class="keys-layout"[\s\S]*class="activation-list"[\s\S]*class="key-details"/);
  assert.match(html, /v-for="key in filteredKeys"[\s\S]*@click="selectKey\(key\)"/);
  assert.match(html, /v-for="update in sortedUpdates"/);
  assert.doesNotMatch(html, /<th>Product key<\/th>/);
  assert.doesNotMatch(html, /<th>License<\/th>|<th>Activation history<\/th>|<th>Activation ID \(AID\)<\/th>/);
  assert.match(html, /No protection key ID available/);
  assert.doesNotMatch(html, /missingActivationIds/);
});

test('downloads V2CP for the chosen protection key and surfaces errors', async () => {
  const root = path.join(__dirname, '..', 'public');
  const html = fs.readFileSync(path.join(root, 'activations.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'v2cp-download.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(root, 'pages', 'activations.js'), 'utf8');
  let definition;
  let calls = 0;
  let fail = false;
  let downloadFails = false;
  const downloads = [];
  let removed = 0;
  const v2cp = '<hasp_info><v2cp>YWJj</v2cp></hasp_info>';
  vm.runInNewContext(script, {
    fetch: async (url, options) => {
      calls++;
      assert.equal(url, '/api/protection-keys/12345/v2cp');
      assert.equal(options.cache, 'no-store');
      return fail
        ? { ok: false, json: async () => ({ error: 'EMS returned 404' }) }
        : { ok: true, json: async () => ({ package: v2cp }) };
    },
    document: {
      createElement(tag) {
        assert.equal(tag, 'a');
        return {
          click() {
            if (downloadFails) throw new Error('Download failed');
            downloads.push({ href: this.href, filename: this.download });
          },
          remove() { removed++; },
        };
      },
      body: { appendChild() {} },
    },
    Vue: { createApp: (options) => { definition = options; return { mount() {} }; } },
  });
  const first = { aid: 'aid-1', productKeyId: 'key-001', protectionKeyId: '12345' };
  const other = { productKeyId: 'key-002' };
  await definition.methods.fetchHistoryPackage.call(definition.methods, first);
  assert.deepEqual(downloads, [{
    href: 'data:application/xml;charset=utf-8,' + encodeURIComponent(v2cp),
    filename: 'Protection-key-12345.v2cp',
  }]);
  assert.equal(removed, 1);
  assert.equal(first.historyPackage.loading, false);
  assert.equal(other.historyPackage, undefined);
  assert.match(html, /@click="fetchHistoryPackage\(selectedKey\)"/);
  assert.match(html, /v-if="selectedKey\.protectionKeyId"[\s\S]*?:disabled="selectedKey\.historyPackage\?\.loading"/);
  assert.match(html, /Download V2CP/);
  assert.doesNotMatch(html, /historyPackage\?\.package/);
  assert.equal(calls, 1);
  await definition.methods.fetchHistoryPackage.call(definition.methods, other);
  assert.equal(calls, 1);
  assert.equal(other.historyPackage, undefined);
  fail = true;
  await definition.methods.fetchHistoryPackage.call(definition.methods, first);
  assert.match(first.historyPackage.error, /404/);
  assert.equal(downloads.length, 1);
  fail = false;
  downloadFails = true;
  await definition.methods.fetchHistoryPackage.call(definition.methods, first);
  assert.match(first.historyPackage.error, /Download failed/);
  assert.equal(removed, 2);
});

test('groups by protection key, preserves unactivated product keys, and filters all identifiers', () => {
  const keys = definitionForKeys().methods.groupKeys([
    { protectionKeyId: '123', productKeyId: 'product-a', customerName: 'Acme', aid: 'aid-a' },
    { protectionKeyId: '123', productKeyId: 'product-b', customerName: 'Acme', aid: 'aid-b' },
    { protectionKeyId: '456', productKeyId: 'product-a', customerName: 'Acme', aid: 'aid-c' },
    { productKeyId: 'product-c', customerName: 'Other' },
  ]);
  assert.equal(keys.length, 3);
  assert.deepEqual(Array.from(keys[0].productKeyIds), ['product-a', 'product-b']);
  assert.deepEqual(Array.from(keys[0].activationIds), ['aid-a', 'aid-b']);
  assert.equal(keys[2].protectionKeyId, '');
  const app = { keys, filter: 'aid-b' };
  assert.equal(definitionForKeys().computed.filteredKeys.call(app)[0].groupId, 'protection:123');
  app.filter = 'product-c';
  assert.equal(definitionForKeys().computed.filteredKeys.call(app)[0].groupId, 'product:product-c');
});

function definitionForKeys(fetchImpl = async () => {}) {
  let definition;
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'pages', 'activations.js'), 'utf8');
  vm.runInNewContext(script, {
    fetch: (...args) => fetchImpl(...args),
    Vue: { createApp: (options) => { definition = options; return { mount() {} }; } },
  });
  return definition;
}

test('selected key shows updates and ignores stale responses and missing protection IDs', async () => {
  let resolveFirst;
  const calls = [];
  const definition = definitionForKeys(async (url) => {
    calls.push(url);
    if (url.includes('/123/')) return new Promise((resolve) => { resolveFirst = resolve; });
    if (url.includes('/456/')) return { ok: true, json: async () => [{ id: '20', type: 3, state: 'DRAFT' }] };
    return { ok: false, json: async () => ({ error: 'EMS unavailable' }) };
  });
  const app = definition.data();
  const first = definition.methods.selectKey.call(app, { protectionKeyId: '123' });
  await definition.methods.selectKey.call(app, { protectionKeyId: '456' });
  assert.equal(app.updates[0].id, '20');
  assert.equal(app.updatesLoading, false);
  resolveFirst({ ok: true, json: async () => [{ id: '30', type: 3 }] });
  await first;
  assert.equal(app.updates[0].id, '20');
  await definition.methods.selectKey.call(app, { protectionKeyId: '789' });
  assert.match(app.updatesError, /EMS unavailable/);
  assert.equal(app.updatesLoading, false);
  await definition.methods.selectKey.call(app, { protectionKeyId: '' });
  assert.equal(app.updates.length, 0);
  assert.equal(app.updatesError, '');
  assert.equal(calls.length, 3);
});

test('key update lookup supports empty results and retry after malformed data', async () => {
  let valid = false;
  const definition = definitionForKeys(async () => ({
    ok: true, json: async () => valid ? [] : [{ id: '20', type: 2 }],
  }));
  const app = definition.data();
  const key = { protectionKeyId: '123' };
  await definition.methods.selectKey.call(app, key);
  assert.match(app.updatesError, /invalid key updates/);
  valid = true;
  await definition.methods.selectKey.call(app, key);
  assert.equal(app.updatesError, '');
  assert.equal(app.updates.length, 0);
  assert.equal(app.updatesLoading, false);
});

test('orders updates newest first by creation instant, with invalid or missing dates last', () => {
  const definition = definitionForKeys();
  const app = {
    updateTimestamp: definition.methods.updateTimestamp,
    updates: [
      { id: '1', createDate: '2026-01-01' },
      { id: '2', createDate: '2026-02-01T10:00:00+13:00' },
      { id: '3', createDate: '2026-01-31T23:00:00Z' },
      { id: '4', createDate: '2026-02-30' },
      { id: '5' },
      { id: '6', createDate: '2026-01-31T23:00:00Z' },
    ],
  };
  assert.deepEqual(Array.from(definition.computed.sortedUpdates.call(app), (update) => update.id),
    ['3', '6', '2', '1', '4', '5']);
  assert.equal(definition.methods.updateCreatedDate.call(app, '2026-02-01T10:00:00+13:00'), '31-01-2026 21:00:00');
  assert.equal(definition.methods.updateCreatedDate.call(app, '2026-02-30'), 'Unavailable');
  assert.deepEqual(app.updates.map((update) => update.id), ['1', '2', '3', '4', '5', '6']);
});

test('builds a V2CP from key history in counter order with numbered V2Cs', async () => {
  const route = activationsRoute({ validHistory: true });
  const { res, calls } = await route.historyPackage('12345');
  assert.equal(res.statusCode, 200);
  const document = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false }).parse(res.body.package);
  assert.equal(document.hasp_info.haspscope.vendor.hasp['@_id'], '12345');
  const zip = new AdmZip(Buffer.from(document.hasp_info.v2cp, 'base64'));
  assert.deepEqual(zip.getEntries().map((entry) => entry.entryName), ['1.v2c', '2.v2c']);
  assert.equal(zip.readAsText('1.v2c'), v2c('12345', '42', 'YWJj'));
  assert.equal(zip.readAsText('2.v2c'), v2c('12345', '42', 'ZGVm'));
  assert.equal(calls.filter((call) => call[0] === 'activation').length, 2);
  assert.equal((await route.historyPackage('invalid/key')).res.statusCode, 400);
  const incomplete = await activationsRoute({ logger: { error() {} } }).historyPackage('12345');
  assert.equal(incomplete.res.statusCode, 502);
  assert.match(incomplete.res.body.error, /warnings/);
});

test('refuses incomplete, ambiguous or mismatched history packages', () => {
  const entry = (aid, updateCounter, activationString = v2c()) =>
    ({ aid, updateCounter, activationString, protectionKeyId: '12345', counterError: null });
  const build = (activations, warnings = []) => buildHistoryV2cp('12345', { activations, warnings });
  assert.throws(() => build([entry('a', '0')], ['missing product key']), /warnings/);
  assert.throws(() => build([entry('a', '0'), entry('b', '2')]), /complete sequence/);
  assert.throws(() => build([entry('a', '0'), entry('b', '0')]), /complete sequence/);
  assert.throws(() => build([entry('a', '0', v2c('999'))]), /scope/);
  assert.throws(() => build([entry('a', '0'), entry('b', '1', v2c('12345', '99'))]), /different protection key scopes/);
  assert.throws(() => build([entry('a', null)]), /missing/);
  assert.throws(() => build([entry('a', '0', '<bad')]), /invalid V2C XML/);
  assert.throws(() => build([entry('a', '0'), entry('a', '1')]), /conflicting records/);
});
