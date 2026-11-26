const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const AdmZip = require('adm-zip');
const { XMLParser } = require('fast-xml-parser');
const { buildHistoryV2cp } = require('../src/v2cp-package');

const featureProductIds = {
  standalone: { add: '25', remove: '29' },
  link: { add: '24', remove: '28' },
  pivot: { add: '22', remove: '27' },
};

function v2c(key = '12345', vendor = '42', payload = 'YWJj') {
  return `<hasp_info><haspscope><vendor id="${vendor}"><hasp id="${key}"/></vendor></haspscope><v2c>${payload}</v2c></hasp_info>`;
}

function activationsRoute({ c2vError, logger = console, validHistory = false, updateDetailsError, associatedIds, invalidUpdateDetails = false, invalidUpdateProducts = false, additionalOriginal = false, updateDescription = { description: 'Added Link\nRemoved Pivot' } } = {}) {
  let handler;
  let pendingUpdatesHandler;
  let historyHandler;
  let historyPackageHandler;
  let keyEntitlementsHandler;
  let countersHandler;
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
        { productKeyId: 'key-001', entitlementId: id, customerName: 'Acme', serialNumber: '06001', serialError: '', totalEntitled: '2', available: '0', activationIds: ['aid-001', 'aid-002'] },
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
      return id === '10' || (id === '11' && additionalOriginal)
        ? { id, lineItemTypes: ['Product_Key'], entState: 'COMPLETED', createDate: '2026-01-01', products: [{ productId: '1', productName: 'Base', memorySegments: [{ name: 'Serial Number', text: '31373731', saot: true }] }] }
        : {
          id, lineItemTypes: ['ProtectionKey_Update'], entState: 'DRAFT', refId1: '00123',
          ...updateDescription,
          products: invalidUpdateProducts ? null : [
            { productId: '24', productName: 'ADD Link', memorySegments: [{ text: 'not included' }] },
            { productId: '27', productName: 'REMOVE Pivot' },
          ],
        };
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
      if (route === '/api/protection-keys/:id/update-counters') countersHandler = handlers.at(-1);
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
    if (name === './entitlement-form-data') return { loadFormData: () => ({
      pivotProductIds: featureProductIds.pivot, featureProductIds, baseProductId: '1',
      versionProducts: [{ id: '21' }], lease: { id: '34' },
    }) };
    if (name.startsWith('.')) return require(path.resolve(root, 'src', name));
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8'), {
    require: customRequire,
    __dirname: path.join(root, 'src'),
    process: { argv: ['node', 'server.js'], env: { IS_TEST_MODE: 'false', PRODUCTION_EMS_URL: 'https://ems.example', ACT_URL: 'https://act.example' } },
    console: logger,
  });
  const invoke = async (handlerToCall, params = {}, query = {}) => {
    const res = {
      statusCode: 200,
      set() { return this; },
      status(code) { this.statusCode = code; return this; },
      json(data) { this.body = data; return this; },
    };
    await handlerToCall({ params, query, ems: new EmsClient() }, res);
    return { res, calls };
  };
  return {
    load: () => invoke(handler),
    history: (id) => invoke(historyHandler, { id }),
    counters: (id) => invoke(countersHandler, { id }),
    keyEntitlements: (id, includeOriginal = false) => invoke(keyEntitlementsHandler, { id }, includeOriginal ? { includeOriginal: '1' } : {}),
    historyPackage: (id) => invoke(historyPackageHandler, { id }),
    pendingUpdates: (aid) => invoke(pendingUpdatesHandler, { aid }),
  };
}

test('lists only update entitlements associated with the requested protection key', async () => {
  const { res, calls } = await activationsRoute().keyEntitlements('12345');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Array.from(res.body, (entry) => [entry.id, entry.type, entry.state, entry.refId1]),
    [['20', 3, 'DRAFT', '00123']]);
  assert.deepEqual(Array.from(res.body[0].products, (product) => [product.productId, product.productName]),
    [['24', 'ADD Link'], ['27', 'REMOVE Pivot']]);
  assert.equal(res.body[0].products[0].memorySegments, undefined);
  assert.equal(res.body[0].description, 'Added Link\nRemoved Pivot');
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
  const missingProducts = await activationsRoute({ invalidUpdateProducts: true, logger: { error() {} } }).keyEntitlements('12345');
  assert.equal(missingProducts.res.statusCode, 502);
  assert.match(missingProducts.res.body.error, /product list/);
  const legacyDescription = await activationsRoute({ updateDescription: { descr: 'Legacy description' } }).keyEntitlements('12345');
  assert.equal(legacyDescription.res.body[0].description, 'Legacy description');
  const noDescription = await activationsRoute({ updateDescription: {} }).keyEntitlements('12345');
  assert.equal(noDescription.res.body[0].description, '');
});

test('timeline includes the original product-key entitlement without changing the update-only response', async () => {
  const route = activationsRoute();
  const { res } = await route.keyEntitlements('12345', true);
  assert.equal(res.body.original.id, '10');
  assert.equal(res.body.original.type, 2);
  assert.equal(res.body.original.products[0].productName, 'Base');
  assert.equal(res.body.original.products[0].memorySegments[0].text, '31373731');
  assert.equal(res.body.baseProductId, '1');
  assert.equal(res.body.versionProductIds[0], '21');
  assert.equal(res.body.leaseProductId, '34');
  assert.equal(res.body.originalError, '');
  assert.equal(res.body.updates[0].id, '20');
  assert.equal(res.body.pivotProductIds.add, '22');
  assert.equal(res.body.pivotProductIds.remove, '27');
  assert.deepEqual(res.body.featureProductIds, featureProductIds);
  const missing = await activationsRoute({ associatedIds: ['20'] }).keyEntitlements('12345', true);
  assert.equal(missing.res.body.original, null);
  assert.match(missing.res.body.originalError, /did not return/);
  assert.equal(missing.res.body.updates.length, 1);
  const ambiguous = await activationsRoute({ associatedIds: ['10', '11', '20'], additionalOriginal: true }).keyEntitlements('12345', true);
  assert.equal(ambiguous.res.body.original, null);
  assert.match(ambiguous.res.body.originalError, /ambiguous/);
  assert.equal(ambiguous.res.body.updates.length, 1);
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
  assert.equal(res.body.activations[0].serialNumber, '06001');
  assert.equal(res.body.activations[0].serialError, '');
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

test('counter endpoint returns scoped history without V2C data', async () => {
  const { res } = await activationsRoute().counters('12345');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Array.from(res.body.activations, (item) => [item.entitlementId, item.aid, item.updateCounter]), [
    ['10', 'history-base', '4'], ['20', 'history-update', null],
  ]);
  assert.equal(res.body.activations[0].activationString, undefined);
  assert.ok(res.body.warnings.length);
  assert.equal((await activationsRoute().counters('bad/id')).res.statusCode, 400);
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
  app.loadCurrentCustomers = definition.methods.loadCurrentCustomers;
  await definition.methods.loadActivations.call(app);
  assert.equal(app.activations[0].productKeyId, 'key-1');
  assert.equal(app.activations[0].aid, null);
  assert.match(html, /class="keys-layout"[\s\S]*class="activation-list"[\s\S]*class="key-details"/);
  assert.match(html, /<h2>\{\{ selectedKey\.currentCustomer\.value \}\} - \{\{ displayValue\(selectedKey\.protectionKeyId\) \}\} - \{\{ selectedKey\.serialNumber \|\| 'Unavailable' \}\} - Details<\/h2>/);
  assert.match(html, /<template v-if="selectedKey\.protectionKeyId">\s*<div class="entitlement-detail-fields" role="table" aria-label="Expected key state">/);
  assert.doesNotMatch(html, /<summary>Expected key state<\/summary>|<p>Customer:|<p>Product key:|<p>Protection key ID:/);
  assert.match(html, /<div class="detail-footer">\s*<p class="detail-footnote">\* Derived from base product memory and version modification writes\.<\/p>/);
  assert.doesNotMatch(html, /This does not confirm they were applied to the key/);
  assert.match(html, /v-for="key in filteredKeys"[\s\S]*@click="selectKey\(key\)"/);
  assert.match(html, /v-for="\(entry, index\) in timelineEntries"/);
  assert.match(html, /<details class="detail-collapsible">\s*<summary>Timeline<\/summary>[\s\S]*class="timeline-entries">[\s\S]*<li v-for="\(entry, index\) in timelineEntries"/);
  assert.match(html, /v-if="updateTimestamp\(entry\.createDate\) !== null" class="timeline-date"[\s\S]*updateCreatedDate\(entry\.createDate\)/);
  assert.match(html, /<span class="timeline-dot" aria-hidden="true"><\/span>/);
  assert.match(html, /<li v-for="\(entry, index\) in timelineEntries"[\s\S]*<details class="detail-collapsible">[\s\S]*<summary>[\s\S]*v-for="\(product, index\) in entry\.products"/);
  assert.match(html, /No products listed for this entitlement/);
  assert.match(html, /Update \{\{ entry\.updateCounter \?\? 'Unavailable' \}\} — \{\{ displayValue\(entry\.description\) \}\}/);
  assert.match(html, /Entitlement ID: \{\{ entry\.id \}\}[\s\S]*Status: \{\{ displayValue\(entry\.state\) \}\}/);
  assert.match(html, /v-if="entry\.type === 3" class="timeline-description">Description: \{\{ displayValue\(entry\.description\) \}\}/);
  assert.doesNotMatch(html, /<th>Product key<\/th>/);
  assert.doesNotMatch(html, /<th>License<\/th>|<th>Activation history<\/th>|<th>Activation ID \(AID\)<\/th>/);
  assert.match(html, /No protection key ID available/);
  assert.doesNotMatch(html, /missingActivationIds/);
});

test('key details use the same desktop scroll panel as entitlement details', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(styles, /@media \(min-width: 641px\)\s*\{\s*\.entitlements-page \.entitlement-details,\s*\.activations-page \.key-details\s*\{\s*max-height: calc\(100vh - 11rem\);\s*overflow-y: auto;/);
  assert.match(styles, /\.entitlements-page \.detail-footnote,\s*\.activations-page \.detail-footnote\s*\{\s*margin: 0;\s*font-size: \.75rem;/);
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
    { protectionKeyId: '123', productKeyId: 'product-a', customerName: 'Acme', aid: 'aid-a', serialNumber: '06001' },
    { protectionKeyId: '123', productKeyId: 'product-b', customerName: 'Acme', aid: 'aid-b', serialNumber: '06001' },
    { protectionKeyId: '456', productKeyId: 'product-a', customerName: 'Acme', aid: 'aid-c', serialNumber: '06001' },
    { productKeyId: 'product-c', customerName: 'Other', serialError: 'Missing serial memory.' },
  ]);
  assert.equal(keys.length, 3);
  assert.deepEqual(Array.from(keys[0].productKeyIds), ['product-a', 'product-b']);
  assert.deepEqual(Array.from(keys[0].activationIds), ['aid-a', 'aid-b']);
  assert.equal(keys[2].protectionKeyId, '');
  assert.equal(keys[0].serialNumber, '06001');
  assert.match(keys[2].serialError, /Missing serial/);
  const app = { keys, filter: 'aid-b' };
  assert.equal(definitionForKeys().computed.filteredKeys.call(app)[0].groupId, 'protection:123');
  app.filter = 'product-c';
  assert.equal(definitionForKeys().computed.filteredKeys.call(app)[0].groupId, 'product:product-c');
  app.filter = '06001';
  assert.equal(definitionForKeys().computed.filteredKeys.call(app).length, 2);
  const conflicting = definitionForKeys().methods.groupKeys([
    { protectionKeyId: '123', productKeyId: 'product-a', serialNumber: '06001' },
    { protectionKeyId: '123', productKeyId: 'product-b', serialNumber: '06002' },
  ]);
  assert.equal(conflicting[0].serialNumber, null);
  assert.match(conflicting[0].serialError, /Conflicting/);
  const missing = definitionForKeys().methods.groupKeys([
    { protectionKeyId: '123', productKeyId: 'product-a', serialNumber: '06001' },
    { protectionKeyId: '123', productKeyId: 'product-b', serialError: 'Missing serial memory.' },
  ]);
  assert.equal(missing[0].serialNumber, null);
  assert.match(missing[0].serialError, /Missing serial/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'activations.html'), 'utf8');
  assert.match(html, /<th>Serial Number<\/th>/);
  assert.match(html, /key\.serialNumber \|\| 'Unavailable'/);
});

function definitionForKeys(fetchImpl = async () => {}) {
  let definition;
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'pages', 'activations.js'), 'utf8');
  vm.runInNewContext(script, {
    fetch: (...args) => fetchImpl(...args),
    EntitlementValues: require('../public/entitlement-values'),
    Vue: { createApp: (options) => { definition = options; return { mount() {} }; } },
  });
  return definition;
}

function timelineResponse(updates, original = { id: '10', type: 2, products: [] }) {
  return { original, originalError: original ? '' : 'Original unavailable', updates };
}

test('reconstructs serial and expiry from base memory and applies version modifications', async () => {
  const base = { productId: '1', memorySegments: [
    { name: 'Serial Number', saot: true, text: '30344432' },
    { name: 'Expiry Date', text: '00000000' },
    { name: 'Version', offset: '0x0000', size: '4', text: '45423544' },
  ] };
  const definition = definitionForKeys(async (url) => {
    if (url.endsWith('/update-counters')) return { ok: true, json: async () => ({
      warnings: [], activations: [
        { entitlementId: '10', aid: 'base', updateCounter: '0' },
        { entitlementId: '20', aid: 'update', updateCounter: '1' },
      ],
    }) };
    if (url === '/api/catalog/products/21/read-only-memory') return { ok: true, json: async () => [{
      kind: 'product', segments: [{ offset: '0', size: '4', saot: false, content: '45373735' }],
    }] };
    return { ok: true, json: async () => ({
      ...timelineResponse([{ id: '20', type: 3, products: [{ productId: '21' }, { productId: '27' }] }],
        { id: '10', type: 2, customer: 'Original', products: [base, { productId: '25' }, { productId: '22' }] }),
      featureProductIds, baseProductId: '1', versionProductIds: ['21'], leaseProductId: '34',
    }) };
  });
  const app = definition.data();
  await definition.methods.selectKey.call(app, { protectionKeyId: '123' });
  const values = definition.computed.expectedMemory.call(app);
  assert.equal(values.serial.value, '01234');
  assert.equal(values.expiry.value, '0000');
  assert.equal(values.version.value, 'v23');
  assert.equal(definition.computed.expectedFeatures.call(app).pivot.value, 'No');
  assert.equal(definition.methods.formatMemoryDate('2024-02-29'), '29-02-2024');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'activations.html'), 'utf8');
  assert.match(html, /Serial Number\*[\s\S]*expectedMemory\.serial\.value/);
  assert.match(html, /Lease Expiry Date\*[\s\S]*expectedMemory\.expiry\.value/);
  assert.match(html, /Irricad Version\*[\s\S]*expectedMemory\.version\.value/);
});

test('uses the last base memory and reports uncertain memory writes', () => {
  const definition = definitionForKeys();
  const base = (serial, expiry, version) => ({ productId: '1', memorySegments: [
    { name: 'Serial Number', saot: true, text: serial },
    { name: 'Expiry Date', text: expiry },
    { name: 'Version', offset: '0', size: '4', text: version },
  ] });
  const app = {
    updatesLoading: false, updatesError: '', originalError: '', counterWarning: '',
    featureProductIds, memoryConfig: { baseProductId: '1', versionProductIds: ['21'], leaseProductId: '34' },
    versionProductMemory: { 21: { files: [{ kind: 'product', segments: [
      { offset: '0', size: '4', saot: false, content: '45373735' },
    ] }] } },
    originalEntitlement: { id: '10', type: 2, products: [base('30344432', '30303030', '45423544')] },
    updates: [
      { id: '20', type: 3, products: [{ productId: '21' }] },
      { id: '21', type: 3, products: [base('31373731', '35383544', '45423544')] },
    ],
    counterHistory: { warnings: [], activations: [
      { entitlementId: '10', aid: 'base', updateCounter: '0' },
      { entitlementId: '20', aid: 'first', updateCounter: '1' },
      { entitlementId: '21', aid: 'second', updateCounter: '2' },
    ] },
  };
  const check = () => definition.computed.expectedMemory.call(app);
  assert.equal(check().serial.value, '06001');
  assert.equal(check().expiry.value, '2024-02-29');
  assert.equal(check().version.value, 'v22');
  app.counterHistory.activations[1].updateCounter = '2';
  app.counterHistory.activations[2].updateCounter = '1';
  assert.equal(check().version.value, 'v23');
  app.versionProductMemory[21] = { error: 'EMS unavailable' };
  assert.match(check().version.reason, /EMS unavailable/);
  assert.equal(check().serial.value, '06001');
  app.versionProductMemory[21] = { files: [{ kind: 'product', segments: [
    { offset: '0', size: '2', saot: false, content: '4537' },
  ] }] };
  assert.match(check().version.reason, /complete fixed Version write/);
  app.updates[0].products = [{ productId: '999' }];
  assert.match(check().serial.reason, /unsupported/);
  app.updates[0].products = [{ productId: '34' }];
  assert.match(check().expiry.reason, /lease update/);
  app.updates[0].products = [];
  assert.match(check().serial.reason, /products are missing/);
  app.memoryConfig.leaseProductId = '21';
  assert.match(check().serial.reason, /configuration is invalid or ambiguous/);
  app.memoryConfig.leaseProductId = '34';
  app.counterHistory.activations[1].updateCounter = null;
  assert.match(check().serial.reason, /missing or ambiguous/);
});

test('ignores a version memory response after selecting another key', async () => {
  let releaseMemory;
  let memoryRequested;
  const requested = new Promise((resolve) => { memoryRequested = resolve; });
  const delayedMemory = new Promise((resolve) => { releaseMemory = resolve; });
  const definition = definitionForKeys(async (url) => {
    if (url === '/api/catalog/products/21/read-only-memory') {
      memoryRequested();
      return delayedMemory;
    }
    const first = url.includes('/111/');
    if (url.endsWith('/update-counters')) return { ok: true, json: async () => ({
      warnings: [], activations: [{ entitlementId: first ? '10' : '11', aid: 'base', updateCounter: '0' }],
    }) };
    return { ok: true, json: async () => ({
      ...timelineResponse([], { id: first ? '10' : '11', type: 2, customer: 'Customer',
        products: [{ productId: '1' }, ...(first ? [{ productId: '21' }] : [])] }),
      featureProductIds, baseProductId: '1', versionProductIds: ['21'], leaseProductId: '34',
    }) };
  });
  const app = definition.data();
  const first = definition.methods.selectKey.call(app, { protectionKeyId: '111' });
  await requested;
  await definition.methods.selectKey.call(app, { protectionKeyId: '222' });
  releaseMemory({ ok: true, json: async () => [{ kind: 'product', segments: [] }] });
  await first;
  assert.equal(app.selectedKey.protectionKeyId, '222');
  assert.equal(app.originalEntitlement.id, '11');
  assert.equal(Object.keys(app.versionProductMemory).length, 0);
  assert.equal(app.updatesLoading, false);
});

test('shows the customer of the latest update by counter, or the original with no updates', () => {
  const definition = definitionForKeys();
  const app = {
    updatesLoading: false, updatesError: '', originalError: '', counterWarning: '',
    originalEntitlement: { id: '10', customer: 'Original', products: [] },
    updates: [
      { id: '20', customer: 'First update', products: [{ productId: '999' }], createDate: '2026-03-01' },
      { id: '21', customer: 'Latest update', products: [], createDate: '2026-01-01' },
    ],
    counterHistory: { warnings: [], activations: [
      { entitlementId: '10', aid: 'base', updateCounter: '0' },
      { entitlementId: '20', aid: 'first', updateCounter: '1' },
      { entitlementId: '21', aid: 'last', updateCounter: '2' },
    ] },
  };
  const check = () => definition.computed.expectedCustomer.call(app);
  assert.equal(check().value, 'Latest update');
  app.counterHistory.activations[2].updateCounter = '1';
  assert.match(check().reason, /sequence/);
  app.counterHistory.activations[2].updateCounter = null;
  assert.match(check().reason, /missing or ambiguous/);
  app.updates = [];
  app.counterHistory.activations = [app.counterHistory.activations[0]];
  assert.equal(check().value, 'Original');
  app.originalEntitlement.customer = '';
  assert.match(check().reason, /customer is unavailable/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'activations.html'), 'utf8');
  assert.match(html, /role="rowheader">Customer<\/div>[\s\S]*expectedCustomer\.value/);
});

test('key list loads the latest counter-ordered customer and reports incomplete history', async () => {
  let customerCalls = 0;
  const definition = definitionForKeys(async (url) => {
    if (url === '/api/customers') {
      customerCalls++;
      return { ok: true, json: async () => [{ customerId: '5', name: 'Latest customer' }] };
    }
    const key = /protection-keys\/(\d+)\//.exec(url)[1];
    if (url.endsWith('/update-counters')) return { ok: true, json: async () => ({
      warnings: key === '333' ? ['missing activation'] : [],
      activations: key === '222' ? [{ entitlementId: '10', aid: 'base', updateCounter: '0' }] : [
        { entitlementId: '10', aid: 'base', updateCounter: '0' },
        { entitlementId: '20', aid: 'first', updateCounter: '1' },
        { entitlementId: '21', aid: 'latest', updateCounter: '2' },
      ],
    }) };
    return { ok: true, json: async () => ({
      ...timelineResponse(key === '222' ? [] : [
        { id: '20', type: 3, customer: 'Older update', products: [], createDate: '2026-03-01' },
        { id: '21', type: 3, customerId: '5', products: [], createDate: '2026-01-01' },
      ], { id: '10', type: 2, customer: 'Original customer', products: [] }),
    }) };
  });
  const app = definition.data();
  app.listRequest = 1;
  const keys = definition.methods.groupKeys([
    { protectionKeyId: '111', productKeyId: 'a', customerName: 'Original customer' },
    { protectionKeyId: '222', productKeyId: 'b', customerName: 'Original customer' },
    { protectionKeyId: '333', productKeyId: 'c', customerName: 'Original customer' },
    { productKeyId: 'd', customerName: 'Unactivated customer' },
  ]);
  await definition.methods.loadCurrentCustomers.call(app, keys, 1);
  assert.equal(keys[0].currentCustomer.value, 'Latest customer');
  assert.equal(keys[1].currentCustomer.value, 'Original customer');
  assert.equal(keys[2].currentCustomer.value, 'Unavailable');
  assert.match(keys[2].currentCustomer.reason, /counter history/i);
  assert.equal(keys[3].currentCustomer.value, 'Unactivated customer');
  assert.equal(customerCalls, 1);
  const filtered = definition.computed.filteredKeys.call({ keys, filter: 'latest customer' });
  assert.equal(filtered[0].groupId, 'protection:111');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'activations.html'), 'utf8');
  assert.match(html, /<th>Current customer<\/th>/);
  assert.match(html, /key\.currentCustomer\.value/);
});

test('key list customer lookup failures and stale reloads are handled explicitly', async () => {
  let releaseCustomer;
  let requested;
  const customerRequested = new Promise((resolve) => { requested = resolve; });
  let mode = 'error';
  const definition = definitionForKeys(async (url) => {
    if (url === '/api/customers') {
      if (mode === 'error') return { ok: false, json: async () => ({ error: 'EMS unavailable' }) };
      requested();
      return new Promise((resolve) => { releaseCustomer = resolve; });
    }
    if (url.endsWith('/update-counters')) return { ok: true, json: async () => ({
      warnings: [], activations: [{ entitlementId: '10', aid: 'base', updateCounter: '0' }],
    }) };
    return { ok: true, json: async () => timelineResponse([],
      { id: '10', type: 2, customerId: '5', products: [] }) };
  });
  const app = definition.data();
  app.listRequest = 1;
  const keys = definition.methods.groupKeys([{ protectionKeyId: '111', productKeyId: 'a' }]);
  await definition.methods.loadCurrentCustomers.call(app, keys, 1);
  assert.equal(keys[0].currentCustomer.value, 'Unavailable');
  assert.match(keys[0].currentCustomer.reason, /EMS unavailable/);
  mode = 'delayed';
  const stale = definition.methods.loadCurrentCustomers.call(app, keys, 1);
  await customerRequested;
  app.listRequest = 2;
  releaseCustomer({ ok: true, json: async () => [{ customerId: '5', name: 'Stale customer' }] });
  await stale;
  assert.equal(keys[0].currentCustomer.value, 'Unavailable');
});

test('resolves the latest entitlement customer ID and surfaces lookup failures', async () => {
  let mode = 'ok';
  const calls = [];
  const definition = definitionForKeys(async (url) => {
    calls.push(url);
    if (url === '/api/customers') {
      if (mode === 'error') return { ok: false, json: async () => ({ error: 'EMS unavailable' }) };
      return { ok: true, json: async () => mode === 'missing' ? [] : [{ customerId: '5', name: 'Latest customer' }] };
    }
    if (url.endsWith('/update-counters')) return { ok: true, json: async () => ({
      warnings: [], activations: [
        { entitlementId: '10', aid: 'base', updateCounter: '0' },
        { entitlementId: '20', aid: 'update', updateCounter: '1' },
      ],
    }) };
    return { ok: true, json: async () => ({
      ...timelineResponse([{ id: '20', type: 3, customerId: 5, products: [{ productId: '27' }] }],
        { id: '10', type: 2, customer: 'Original', products: [{ productId: '1' }] }),
      featureProductIds,
    }) };
  });
  const app = definition.data();
  for (mode of ['ok', 'missing', 'error']) {
    await definition.methods.selectKey.call(app, { protectionKeyId: '123' });
    const result = definition.computed.expectedCustomer.call(app);
    if (mode === 'ok') assert.equal(result.value, 'Latest customer');
    else {
      assert.equal(result.value, 'Unavailable');
      assert.match(result.reason, mode === 'missing' ? /not found/ : /EMS unavailable/);
    }
    assert.equal(definition.computed.expectedFeatures.call(app).pivot.value, 'No');
  }
  assert.equal(calls.filter((url) => url === '/api/customers').length, 3);
});

test('ignores a customer lookup for a previously selected key', async () => {
  let resolveFirstCustomer;
  const definition = definitionForKeys(async (url) => {
    if (url === '/api/customers') return new Promise((resolve) => { resolveFirstCustomer = resolve; });
    if (url.endsWith('/update-counters')) return { ok: true, json: async () => ({
      warnings: [], activations: [{ entitlementId: '10', aid: 'base', updateCounter: '0' }],
    }) };
    const original = url.includes('/123/')
      ? { id: '10', type: 2, customerId: '5', products: [{ productId: '1' }] }
      : { id: '10', type: 2, customer: 'Second customer', products: [{ productId: '1' }] };
    return { ok: true, json: async () => ({ ...timelineResponse([], original), featureProductIds }) };
  });
  const app = definition.data();
  const first = definition.methods.selectKey.call(app, { protectionKeyId: '123' });
  await new Promise((resolve) => setImmediate(resolve));
  await definition.methods.selectKey.call(app, { protectionKeyId: '456' });
  resolveFirstCustomer({ ok: true, json: async () => [{ customerId: '5', name: 'First customer' }] });
  await first;
  assert.equal(definition.computed.expectedCustomer.call(app).value, 'Second customer');
  assert.equal(app.customerLookup, null);
});

test('reconstructs Pivot from the original and the last counter-ordered update', async () => {
  const updates = [
    { id: '20', type: 3, products: [{ productId: '27' }], createDate: '2026-03-01' },
    { id: '21', type: 3, products: [{ productId: '22' }], createDate: '2026-01-01' },
    { id: '22', type: 3, products: [{ productId: '27' }], createDate: '2026-02-01' },
  ];
  const original = { id: '10', type: 2, products: [{ productId: '1' }, { productId: '22' }] };
  const activations = [
    { entitlementId: '10', aid: 'base', updateCounter: '0' },
    { entitlementId: '20', aid: 'remove', updateCounter: '1' },
    { entitlementId: '21', aid: 'add', updateCounter: '2' },
    { entitlementId: '22', aid: 'last', updateCounter: '3' },
  ];
  const definition = definitionForKeys(async (url) => ({
    ok: true,
    json: async () => url.endsWith('/update-counters')
      ? { activations, warnings: [] }
      : { ...timelineResponse(updates, original), featureProductIds },
  }));
  const app = definition.data();
  await definition.methods.selectKey.call(app, { protectionKeyId: '123' });
  assert.equal(definition.computed.expectedFeatures.call(app).pivot.value, 'No');
  activations[2].updateCounter = '3';
  activations[3].updateCounter = '2';
  assert.equal(definition.computed.expectedFeatures.call(app).pivot.value, 'Yes');
  app.updates = [];
  app.counterHistory = { activations: [activations[0]], warnings: [] };
  assert.equal(definition.computed.expectedFeatures.call(app).pivot.value, 'Yes');
  app.originalEntitlement = { ...original, products: [{ productId: '1' }] };
  assert.equal(definition.computed.expectedFeatures.call(app).pivot.value, 'No');
});

test('does not guess Pivot when history or product effects are uncertain', () => {
  const definition = definitionForKeys();
  const app = {
    updatesLoading: false, updatesError: '', originalError: '', counterWarning: '',
    originalEntitlement: { id: '10', products: [{ productId: '1' }] },
    updates: [{ id: '20', products: [{ productId: '22' }] }],
    featureProductIds: { pivot: { add: '22', remove: '27' } },
    counterHistory: { warnings: [], activations: [
      { entitlementId: '10', aid: 'base', updateCounter: '0' },
      { entitlementId: '20', aid: 'update', updateCounter: '1' },
    ] },
  };
  const check = () => definition.computed.expectedFeatures.call(app).pivot;
  assert.equal(check().value, 'Yes');
  app.counterHistory.activations[1].updateCounter = '2';
  assert.match(check().reason, /sequence/);
  app.counterHistory.activations[1].updateCounter = '0';
  assert.match(check().reason, /sequence/);
  app.counterHistory.activations[1].updateCounter = null;
  assert.match(check().reason, /missing or ambiguous/);
  app.counterHistory.activations[1].updateCounter = '1';
  app.counterHistory.warnings = ['missing activation'];
  assert.equal(check().value, 'Unavailable');
  app.counterHistory.warnings = [];
  app.updates[0].products.push({ productId: '27' });
  assert.match(check().reason, /conflicting/);
  app.updates[0].products = [{ productId: '24' }];
  assert.match(check().reason, /unsupported/);
  app.updates[0].products = [{ productId: '22' }];
  app.featureProductIds.pivot.remove = '';
  assert.match(check().reason, /not configured/);
  app.featureProductIds.pivot.remove = '27';
  app.originalEntitlement.products.push({ productId: '27' });
  assert.match(check().reason, /original entitlement/);
});

test('discards stale counter history when a different key is selected', async () => {
  let resolveFirstHistory;
  const definition = definitionForKeys(async (url) => {
    if (url.includes('/123/') && url.endsWith('/update-counters')) {
      return new Promise((resolve) => { resolveFirstHistory = resolve; });
    }
    if (url.endsWith('/update-counters')) return { ok: true, json: async () => ({
      warnings: [], activations: [{ entitlementId: '10', aid: 'second', updateCounter: '0' }],
    }) };
    return { ok: true, json: async () => ({
      ...timelineResponse([], { id: '10', type: 2, products: [{ productId: '1' }] }),
      featureProductIds,
    }) };
  });
  const app = definition.data();
  const first = definition.methods.selectKey.call(app, { protectionKeyId: '123' });
  await new Promise((resolve) => setImmediate(resolve));
  await definition.methods.selectKey.call(app, { protectionKeyId: '456' });
  resolveFirstHistory({ ok: true, json: async () => ({
    warnings: [], activations: [{ entitlementId: '10', aid: 'first', updateCounter: '0' }],
  }) });
  await first;
  assert.equal(app.counterHistory.activations[0].aid, 'second');
  assert.equal(definition.computed.expectedFeatures.call(app).pivot.value, 'No');
});

test('reconstructs independent features through mixed updates in counter order', () => {
  const definition = definitionForKeys();
  const app = {
    updatesLoading: false, updatesError: '', originalError: '', counterWarning: '',
    featureProductIds,
    originalEntitlement: { id: '10', products: [{ productId: '1' }, { productId: '25' }, { productId: '22' }] },
    updates: [
      { id: '20', products: [{ productId: '29' }, { productId: '24' }] },
      { id: '21', products: [{ productId: '25' }, { productId: '27' }] },
      { id: '22', products: [{ productId: '28' }] },
    ],
    counterHistory: { warnings: [], activations: [
      { entitlementId: '10', aid: 'base', updateCounter: '0' },
      { entitlementId: '20', aid: 'first', updateCounter: '1' },
      { entitlementId: '21', aid: 'second', updateCounter: '2' },
      { entitlementId: '22', aid: 'third', updateCounter: '3' },
    ] },
  };
  const check = () => definition.computed.expectedFeatures.call(app);
  assert.deepEqual(['standalone', 'link', 'pivot'].map((name) => check()[name].value), ['Yes', 'No', 'No']);
  app.counterHistory.activations[1].updateCounter = '3';
  app.counterHistory.activations[3].updateCounter = '1';
  assert.deepEqual(['standalone', 'link', 'pivot'].map((name) => check()[name].value), ['No', 'Yes', 'No']);
  app.updates[0].products.push({ productId: '25' });
  assert.match(check().standalone.reason, /conflicting/);
  assert.equal(check().link.value, 'Yes');
  app.updates[0].products.push({ productId: '999' });
  assert.match(check().link.reason, /unsupported/);
});

test('reconstructs lease presence from the original and updates without a removal', () => {
  const definition = definitionForKeys();
  const app = {
    updatesLoading: false, updatesError: '', originalError: '', counterWarning: '',
    featureProductIds, memoryConfig: { baseProductId: '1', versionProductIds: ['21'], leaseProductId: '34' },
    originalEntitlement: { id: '10', products: [{ productId: '1' }, { productId: '22' }] },
    updates: [
      { id: '20', products: [{ productId: '27' }] },
      { id: '21', products: [{ productId: '21' }] },
    ],
    counterHistory: { warnings: [], activations: [
      { entitlementId: '10', aid: 'base', updateCounter: '0' },
      { entitlementId: '20', aid: 'first', updateCounter: '1' },
      { entitlementId: '21', aid: 'second', updateCounter: '2' },
    ] },
  };
  const check = () => definition.computed.expectedFeatures.call(app);
  assert.equal(check().lease.value, 'No');
  app.originalEntitlement.products.push({ productId: '34' });
  assert.equal(check().lease.value, 'Yes');
  app.originalEntitlement.products.pop();
  app.updates[0].products.push({ productId: '1' }, { productId: '34' });
  assert.equal(check().lease.value, 'Yes');
  assert.equal(check().pivot.value, 'No');
  app.updates[1].products.push({ productId: '999' });
  assert.match(check().lease.reason, /unsupported/);
  app.updates[1].products.pop();
  app.updates[0].products.pop();
  app.memoryConfig.leaseProductId = '';
  assert.match(check().lease.reason, /not configured/);
  app.memoryConfig.leaseProductId = '34';
  app.counterHistory.activations[1].updateCounter = null;
  assert.match(check().lease.reason, /missing or ambiguous/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'activations.html'), 'utf8');
  assert.match(html, /key: 'lease', label: 'Lease Irricad'/);
});

test('reports missing and ambiguous feature configuration without guessing', () => {
  const definition = definitionForKeys();
  const app = {
    updatesLoading: false, updatesError: '', originalError: '', counterWarning: '',
    featureProductIds: {
      standalone: { add: '25', remove: '' },
      link: { add: '24', remove: '28' },
      pivot: { add: '22', remove: '27' },
    },
    originalEntitlement: { id: '10', products: [{ productId: '1' }, { productId: '25' }] },
    updates: [{ id: '20', products: [{ productId: '24' }] }],
    counterHistory: { warnings: [], activations: [
      { entitlementId: '10', aid: 'base', updateCounter: '0' },
      { entitlementId: '20', aid: 'update', updateCounter: '1' },
    ] },
  };
  const check = () => definition.computed.expectedFeatures.call(app);
  assert.match(check().standalone.reason, /not configured/);
  assert.equal(check().link.value, 'Yes');
  app.featureProductIds.standalone.remove = '28';
  assert.match(check().link.reason, /ambiguous/);
});

test('selected key shows updates and ignores stale responses and missing protection IDs', async () => {
  let resolveFirst;
  const calls = [];
  const definition = definitionForKeys(async (url) => {
    calls.push(url);
    if (url.includes('/123/')) return new Promise((resolve) => { resolveFirst = resolve; });
    if (url.endsWith('/update-counters')) return { ok: true, json: async () => ({ activations: [], warnings: [] }) };
    if (url.includes('/456/')) return { ok: true, json: async () => timelineResponse([{ id: '20', type: 3, state: 'DRAFT', products: [] }]) };
    return { ok: false, json: async () => ({ error: 'EMS unavailable' }) };
  });
  const app = definition.data();
  const first = definition.methods.selectKey.call(app, { protectionKeyId: '123' });
  await definition.methods.selectKey.call(app, { protectionKeyId: '456' });
  assert.equal(app.updates[0].id, '20');
  assert.equal(app.updatesLoading, false);
  resolveFirst({ ok: true, json: async () => timelineResponse([{ id: '30', type: 3, products: [] }]) });
  await first;
  assert.equal(app.updates[0].id, '20');
  assert.equal(app.originalEntitlement.id, '10');
  await definition.methods.selectKey.call(app, { protectionKeyId: '789' });
  assert.match(app.updatesError, /EMS unavailable/);
  assert.equal(app.updatesLoading, false);
  await definition.methods.selectKey.call(app, { protectionKeyId: '' });
  assert.equal(app.updates.length, 0);
  assert.equal(app.originalEntitlement, null);
  assert.equal(app.updatesError, '');
  assert.equal(calls.length, 4);
});

test('matches unambiguous counters to updates and reports unavailable history', async () => {
  let mode = 'ok';
  const updates = [
    { id: '20', type: 3, products: [] }, { id: '21', type: 3, products: [] },
    { id: '22', type: 3, products: [] },
  ];
  const definition = definitionForKeys(async (url) => {
    if (url.endsWith('/entitlements?includeOriginal=1')) return { ok: true, json: async () => timelineResponse(updates) };
    if (mode === 'error') return { ok: false, json: async () => ({ error: 'EMS unavailable' }) };
    return { ok: true, json: async () => ({
      warnings: mode === 'warnings' ? ['missing activation'] : [],
      activations: [
        { entitlementId: '20', aid: 'a', updateCounter: '12', counterError: null },
        { entitlementId: '21', aid: 'b', updateCounter: '4', counterError: null },
        { entitlementId: '21', aid: 'c', updateCounter: '5', counterError: null },
        { entitlementId: '22', aid: 'd', updateCounter: null, counterError: 'missing' },
      ],
    }) };
  });
  const app = definition.data();
  const key = { protectionKeyId: '123' };
  await definition.methods.selectKey.call(app, key);
  assert.deepEqual(Array.from(app.updates, (update) => update.updateCounter), ['12', null, null]);
  assert.match(app.updates[1].counterIssue, /ambiguous/);
  assert.match(app.updates[2].counterIssue, /lookup failed: missing/);
  mode = 'warnings';
  await definition.methods.selectKey.call(app, key);
  assert.match(app.counterWarning, /missing activation/);
  assert.equal(app.updates[0].updateCounter, undefined);
  mode = 'error';
  await definition.methods.selectKey.call(app, key);
  assert.match(app.counterWarning, /EMS unavailable/);
  assert.equal(app.updates.length, 3);
  assert.equal(app.updatesLoading, false);
});

test('key update lookup supports empty results and retry after malformed data', async () => {
  let valid = false;
  const definition = definitionForKeys(async () => ({
    ok: true, json: async () => timelineResponse(valid ? [] : [{ id: '20', type: 2 }]),
  }));
  const app = definition.data();
  const key = { protectionKeyId: '123' };
  await definition.methods.selectKey.call(app, key);
  assert.match(app.updatesError, /invalid key timeline data/);
  valid = true;
  await definition.methods.selectKey.call(app, key);
  assert.equal(app.updatesError, '');
  assert.equal(app.updates.length, 0);
  assert.equal(app.originalEntitlement.id, '10');
  assert.equal(app.updatesLoading, false);
});

test('places the original entitlement after the sorted updates', () => {
  const definition = definitionForKeys();
  const original = { id: '10', type: 2, createDate: '2024-01-01' };
  const updates = [{ id: '20', type: 3 }, { id: '30', type: 3 }];
  const entries = definition.computed.timelineEntries.call({ originalEntitlement: original, sortedUpdates: updates });
  assert.deepEqual(Array.from(entries, (entry) => entry.id), ['20', '30', '10']);
  const withoutOriginal = definition.computed.timelineEntries.call({ originalEntitlement: null, sortedUpdates: updates });
  assert.deepEqual(Array.from(withoutOriginal, (entry) => entry.id), ['20', '30']);
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

test('orders by descending update counter before falling back to creation date', () => {
  const definition = definitionForKeys();
  const app = {
    updateTimestamp: definition.methods.updateTimestamp,
    updates: [
      { id: '1', updateCounter: '2', createDate: '2026-03-01' },
      { id: '2', updateCounter: '100000000000000000000', createDate: '2026-01-01' },
      { id: '3', createDate: '2026-05-01' },
      { id: '4', createDate: '2026-04-01' },
    ],
  };
  assert.deepEqual(Array.from(definition.computed.sortedUpdates.call(app), (update) => update.id), ['2', '1', '3', '4']);
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
