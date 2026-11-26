const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'entitlements.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'pages', 'entitlements.js'), 'utf8');
const v2cpDownloadScript = fs.readFileSync(path.join(__dirname, '..', 'public', 'v2cp-download.js'), 'utf8');
let definition;
let fetchMemory;
let confirmProduce = () => true;
const pageLocation = { search: '' };
const pageWindow = {
  confirm: (...args) => confirmProduce(...args),
  location: pageLocation,
  setTimeout,
  clearTimeout,
};
const downloads = [];
const pageDocument = {
  createElement() {
    return { click() { downloads.push({ href: this.href, filename: this.download }); }, remove() {} };
  },
  body: { appendChild() {} },
};
vm.runInNewContext(v2cpDownloadScript + '\n' + script, {
  fetch: (...args) => fetchMemory(...args),
  window: pageWindow,
  document: pageDocument,
  URLSearchParams,
  EntitlementValues: require('../public/entitlement-values'),
  Vue: { createApp: (options) => { definition = options; return { mount() {} }; } },
});

test('produce eligibility requires a draft and only Product Key line items', () => {
  const app = { selectedEntitlement: { entState: 'DRAFT', lineItemTypes: ['Product_Key'] } };
  assert.equal(definition.computed.canProduce.call(app), true);
  for (const types of [[], ['Product_Key', 'Hardware_Key'], ['Product_Key', undefined]]) {
    app.selectedEntitlement.lineItemTypes = types;
    assert.equal(definition.computed.canProduce.call(app), false);
  }
  app.selectedEntitlement = { entState: 'PRODUCED', lineItemTypes: ['Product_Key'] };
  assert.equal(definition.computed.canProduce.call(app), false);
});

test('uses one confirmation button instead of per-field checkboxes', () => {
  const details = html.match(/<div class="entitlement-detail-fields"[^>]*>([\s\S]*?)<\/div>\s*<div v-if="!isKeyUpdate \|\| canProduce" class="detail-footer"/)[1];
  assert.doesNotMatch(details, /<input type="checkbox"/);
  assert.match(html, /<button type="button"[^>]*:aria-pressed="detailsConfirmed" @click="confirmDetailsReviewed">I have checked these<\/button>\s*<button type="button" class="button--constructive"[^>]*:disabled="!detailsConfirmed/);
});

test('review confirmation expires after five seconds and can be reset early', () => {
  const originalSetTimeout = pageWindow.setTimeout;
  const originalClearTimeout = pageWindow.clearTimeout;
  let timeoutCallback;
  let timeoutDelay;
  let clearedTimeout;
  pageWindow.setTimeout = (callback, delay) => {
    timeoutCallback = callback;
    timeoutDelay = delay;
    return 42;
  };
  pageWindow.clearTimeout = (timeout) => { clearedTimeout = timeout; };
  try {
    const app = {
      canProduce: true,
      detailsConfirmed: false,
      detailsConfirmationTimeout: null,
      detailLoading: false,
      detailError: '',
    };
    definition.methods.confirmDetailsReviewed.call(app);
    assert.equal(app.detailsConfirmed, true);
    assert.equal(timeoutDelay, 5000);
    timeoutCallback();
    assert.equal(app.detailsConfirmed, false);
    assert.equal(app.detailsConfirmationTimeout, null);

    definition.methods.confirmDetailsReviewed.call(app);
    definition.methods.clearDetailsConfirmation.call(app);
    assert.equal(clearedTimeout, 42);
    assert.equal(app.detailsConfirmed, false);
  } finally {
    pageWindow.setTimeout = originalSetTimeout;
    pageWindow.clearTimeout = originalClearTimeout;
  }
});

test('deletion is available only for draft entitlements', async () => {
  const app = {
    selectedEntitlement: { id: '123', entState: 'DRAFT' },
    deleting: false,
    activating: false,
    displayValue: definition.methods.displayValue,
  };
  Object.defineProperty(app, 'canDelete', { get: () => definition.computed.canDelete.call(app) });
  assert.equal(definition.computed.canDelete.call(app), true);
  app.selectedEntitlement = { id: '123', state: 'PRODUCT_KEY_GENERATED' };
  assert.equal(definition.computed.canDelete.call(app), false);
  assert.match(html, /:disabled="!canDelete \|\| deleting \|\| producing \|\| reopening \|\| activating"/);

  let calls = 0;
  fetchMemory = async () => { calls++; };
  await definition.methods.deleteSelectedEntitlement.call(app);
  assert.equal(calls, 0);
});

test('reopen is limited to eligible states, confirmed, and blocks uncertain retries', async () => {
  for (const state of ['PRODUCT_KEY_GENERATED', 'QUEUED']) {
    assert.equal(definition.computed.canReopen.call({ selectedEntitlement: { entState: state } }), true);
  }
  assert.equal(definition.computed.canReopen.call({ selectedEntitlement: { entState: 'DRAFT' } }), false);
  assert.match(html, /<button v-if="canReopen"[^>]*@click="reopenSelectedEntitlement">[\s\S]*?Reopen entitlement/);
  assert.match(html, /v-if="canReopen" class="form-hint">Reopening returns this entitlement to draft state, where it can be deleted\./);

  const app = {
    selectedEntitlement: { id: '123', entState: 'PRODUCT_KEY_GENERATED', customerName: 'Acme' },
    reopening: false, deleting: false, producing: false, loading: false, reopenUncertain: false,
    productKeys: [{ productKeyId: 'key-001' }], notice: '',
    canReopen: true,
    displayValue: definition.methods.displayValue,
    clearDetailsConfirmation: definition.methods.clearDetailsConfirmation,
    async loadEntitlements() {},
  };
  let calls = 0;
  const confirmations = [];
  fetchMemory = async (url, options) => {
    calls++;
    assert.equal(url, '/api/entitlements/123/reopen');
    assert.equal(options.method, 'POST');
    return { ok: true, json: async () => ({ reopened: true, state: 'DRAFT' }) };
  };
  confirmProduce = () => false;
  await definition.methods.reopenSelectedEntitlement.call(app);
  assert.equal(calls, 0);
  confirmProduce = (message) => { confirmations.push(message); return true; };
  await definition.methods.reopenSelectedEntitlement.call(app);
  assert.match(confirmations[0], /product key and its text file will become invalid/i);
  assert.equal(calls, 1);
  assert.equal(app.selectedEntitlement.entState, 'DRAFT');
  assert.equal(app.productKeys.length, 0);
  assert.equal(app.notice, 'Entitlement 123 reopened as a draft.');

  app.selectedEntitlement.entState = 'PRODUCT_KEY_GENERATED';
  fetchMemory = async () => {
    calls++;
    return { ok: false, json: async () => ({ error: 'unknown', outcomeUnknown: true }) };
  };
  await definition.methods.reopenSelectedEntitlement.call(app);
  await definition.methods.reopenSelectedEntitlement.call(app);
  assert.equal(calls, 2);
  assert.equal(app.reopenUncertain, true);
  assert.match(app.reopenError, /Reload the entitlement before retrying/);
});

test('produce confirms, reloads list and selected details on success and blocks uncertain retries', async () => {
  const app = {
    selectedEntitlement: { id: '123', entState: 'DRAFT', lineItemTypes: ['Product_Key'] },
    detailsConfirmed: false,
    producing: false, deleting: false, detailLoading: false, detailError: '', produceUncertain: false,
    clearDetailsConfirmation: definition.methods.clearDetailsConfirmation,
    loadEntitlements: definition.methods.loadEntitlements,
    openEntitlementDetails: async (entitlement) => {
      assert.equal(app.producing, false);
      app.selectedEntitlement = { ...entitlement, entState: entitlement.state };
    },
  };
  Object.defineProperty(app, 'canProduce', { get: () => definition.computed.canProduce.call(app) });
  let calls = 0;
  fetchMemory = async (url, options) => {
    calls++;
    if (url === '/api/entitlements/123/produce') {
      assert.equal(options.method, 'POST');
      return { ok: true, json: async () => ({ produced: true, state: 'PRODUCT_KEY_GENERATED' }) };
    }
    assert.equal(url, '/api/entitlements');
    return { ok: true, json: async () => [{ id: '123', state: 'PRODUCT_KEY_GENERATED' }] };
  };
  confirmProduce = () => true;
  await definition.methods.produceSelectedEntitlement.call(app);
  assert.equal(calls, 0);
  app.detailsConfirmed = true;
  confirmProduce = () => false;
  await definition.methods.produceSelectedEntitlement.call(app);
  assert.equal(calls, 0);
  confirmProduce = () => true;
  await definition.methods.produceSelectedEntitlement.call(app);
  assert.equal(calls, 2);
  assert.equal(app.selectedEntitlement.entState, 'PRODUCT_KEY_GENERATED');
  assert.equal(app.entitlements[0].state, 'PRODUCT_KEY_GENERATED');
  app.selectedEntitlement = { id: '123', entState: 'DRAFT', lineItemTypes: ['Product_Key'] };
  app.detailsConfirmed = true;
  fetchMemory = async () => { calls++; throw new Error('network error'); };
  await definition.methods.produceSelectedEntitlement.call(app);
  assert.equal(app.produceUncertain, true);
  assert.match(app.produceError, /Reload/);
});

test('displays the serial counter warning after a draft was saved', () => {
  const app = {
    loadFilterPreferences() {},
    loadEntitlements() {},
    loadCustomers() {},
  };
  pageLocation.search = '?created=1&serialWarning=counter%20update%20failed';
  definition.mounted.call(app);
  assert.equal(app.notice, 'Entitlement saved as a draft, but the serial number could not be advanced: counter update failed');
});

test('opening or reloading entitlement details clears the review confirmation', async () => {
  const app = {
    producing: false, detailRequest: 0, detailsConfirmed: true,
    customers: [], loadVersionMemory: async () => undefined,
    clearDetailsConfirmation: definition.methods.clearDetailsConfirmation,
  };
  fetchMemory = async () => ({ ok: true, json: async () => ({ products: [] }) });
  await definition.methods.openEntitlementDetails.call(app, { id: '1' });
  assert.equal(app.detailsConfirmed, false);
  app.detailsConfirmed = true;
  await definition.methods.openEntitlementDetails.call(app, { id: '2' });
  assert.equal(app.detailsConfirmed, false);
});

test('keeps the selected list type for the details outline after loading', async () => {
  const app = {
    producing: false, detailRequest: 0, customers: [],
    loadVersionMemory: async () => undefined,
    clearDetailsConfirmation: definition.methods.clearDetailsConfirmation,
  };
  fetchMemory = async () => ({ ok: true, json: async () => ({ products: [] }) });
  for (const type of [2, 3, 1]) {
    await definition.methods.openEntitlementDetails.call(app, { id: '1', type });
    assert.equal(app.selectedEntitlement.type, type);
  }
  fetchMemory = async () => ({ ok: true, json: async () => ({ products: [], type: 3 }) });
  await definition.methods.openEntitlementDetails.call(app, { id: '1', type: 2 });
  assert.equal(app.selectedEntitlement.type, 2);
  await definition.methods.openEntitlementDetails.call(app, { id: '1' });
  assert.equal(app.selectedEntitlement.type, 3);
  assert.match(html, /class="entitlement-details" :class="selectedEntitlement \? typeMarkerClass\(selectedEntitlement\.type\) : null"/);
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(styles, /\.entitlement-details \{[^}]*border: 1px solid var\(--color-border\)/);
  assert.match(styles, /\.entitlement-details\.product-key \{ border-color: var\(--entitlement-product-key-color\); \}/);
  assert.match(styles, /\.entitlement-details\.key-update \{ border-color: var\(--entitlement-key-update-color\); \}/);
});

test('hides the base-product details table and footnote only for key updates', () => {
  const app = { selectedEntitlement: { type: ' 3 ' }, typeMarkerClass: definition.methods.typeMarkerClass };
  assert.equal(definition.computed.isKeyUpdate.call(app), true);
  for (const type of [2, 1, undefined]) {
    app.selectedEntitlement.type = type;
    assert.equal(definition.computed.isKeyUpdate.call(app), false);
  }
  assert.match(html, /class="entitlement-detail-fields" v-if="!isKeyUpdate" role="table" aria-label="Entitlement attributes"/);
  assert.match(html, /<p v-if="!isKeyUpdate" class="detail-footnote">/);
  assert.match(html, /<section v-if="isEntitlementComplete" class="product-key-details">/);
});

test('loads product key details and ignores responses for a previous selection', async () => {
  let finish;
  fetchMemory = () => new Promise((resolve) => { finish = resolve; });
  const app = { detailRequest: 1, productKeys: [], productKeyLoading: false, productKeyError: '' };
  const pending = definition.methods.loadProductKeys.call(app, '123', 1);
  assert.equal(app.productKeyLoading, true);
  app.detailRequest = 2;
  app.productKeyLoading = false;
  finish({ ok: true, json: async () => [{ productKeyId: 'old' }] });
  await pending;
  assert.equal(app.productKeys.length, 0);
  fetchMemory = async () => ({ ok: false, statusText: 'Not Found', json: async () => ({ error: 'not found' }) });
  await definition.methods.loadProductKeys.call(app, '124', 2);
  assert.match(app.productKeyError, /not found/);
  fetchMemory = async (url) => {
    assert.equal(url, '/api/entitlements/124/product-keys');
    return { ok: true, json: async () => [{ productKeyId: 'new' }] };
  };
  await definition.methods.loadProductKeys.call(app, '124', 2);
  assert.equal(app.productKeys[0].productKeyId, 'new');
  assert.equal(app.productKeyError, '');
  assert.equal(app.productKeyLoading, false);
  assert.equal(definition.computed.isProductKeyGenerated.call({ selectedEntitlement: { entState: 'PRODUCT_KEY_GENERATED' } }), true);
  assert.equal(definition.computed.isProductKeyGenerated.call({ selectedEntitlement: { entState: 'DRAFT' } }), false);
});

test('opening a generated entitlement loads its product keys', async () => {
  assert.match(html, /<details v-if="isProductKeyGenerated" class="detail-collapsible product-key-details">\s*<summary>Product Key<\/summary>[\s\S]*?<\/details>/);
  const app = {
    producing: false, detailRequest: 0, customers: [], detailsConfirmed: true,
    clearDetailsConfirmation: definition.methods.clearDetailsConfirmation,
    loadVersionMemory: async () => undefined,
    loadProductKeys: definition.methods.loadProductKeys,
  };
  fetchMemory = async (url) => {
    if (url === '/api/entitlements/123') {
      return { ok: true, json: async () => ({ id: '123', entState: 'PRODUCT_KEY_GENERATED', products: [] }) };
    }
    assert.equal(url, '/api/entitlements/123/product-keys');
    return { ok: true, json: async () => [{ productKeyId: 'key-001', productInfo: [], activationAttribute: [] }] };
  };
  await definition.methods.openEntitlementDetails.call(app, { id: '123' });
  assert.equal(app.productKeys[0].productKeyId, 'key-001');
  assert.equal(app.productKeyError, '');
  assert.equal(app.detailLoading, false);
});

test('completed entitlement displays its product keys and associated protection keys', async () => {
  const app = {
    producing: false, detailRequest: 0, customers: [],
    clearDetailsConfirmation: definition.methods.clearDetailsConfirmation,
    loadVersionMemory: async () => undefined,
    loadProductKeys: definition.methods.loadProductKeys,
  };
  fetchMemory = async (url) => {
    if (url === '/api/entitlements/123') {
      return { ok: true, json: async () => ({ id: '123', entState: 'COMPLETED', products: [] }) };
    }
    assert.equal(url, '/api/entitlements/123/product-keys');
    return { ok: true, json: async () => [{
      productKeyId: 'key-001',
      activationReferences: [
        { protectionKeyId: '12345' }, { protectionKeyId: '12345' },
        { protectionKeyId: '67890' }, { protectionKeyId: null },
      ],
    }] };
  };
  await definition.methods.openEntitlementDetails.call(app, { id: '123' });
  assert.equal(app.productKeys[0].productKeyId, 'key-001');
  assert.deepEqual(Array.from(definition.methods.protectionKeyIds(app.productKeys[0])), ['12345', '67890']);
  assert.deepEqual(Array.from(definition.methods.protectionKeyIds({})), []);
  assert.equal(definition.computed.isEntitlementComplete.call(app), true);
  assert.equal(definition.computed.isEntitlementComplete.call({ selectedEntitlement: { entState: 'DRAFT' } }), false);
  assert.match(html, /v-if="isEntitlementComplete"[\s\S]*?Product key ID:[\s\S]*?Protection key ID:[\s\S]*?@click="downloadHistoryPackage\(id\)"/);
  assert.match(html, /Protection key ID: Unavailable/);
  assert.doesNotMatch(html, /Fetch pending updates \(V2CP\)/);
});

test('completed entitlement downloads a V2CP and discards results after selection changes', async () => {
  downloads.length = 0;
  const app = definition.data();
  app.detailRequest = 1;
  fetchMemory = async (url) => {
    assert.equal(url, '/api/protection-keys/12345/v2cp');
    return { ok: true, json: async () => ({ package: '<hasp_info/>' }) };
  };
  await definition.methods.downloadHistoryPackage.call(app, '12345');
  assert.equal(downloads[0].filename, 'Protection-key-12345.v2cp');
  assert.equal(downloads[0].href, 'data:application/xml;charset=utf-8,' + encodeURIComponent('<hasp_info/>'));
  fetchMemory = async () => {
    app.detailRequest++;
    return { ok: true, json: async () => ({ package: '<hasp_info/>' }) };
  };
  await definition.methods.downloadHistoryPackage.call(app, '12345');
  assert.equal(downloads.length, 1);
  fetchMemory = async () => ({ ok: false, json: async () => ({ error: 'incomplete history' }) });
  await definition.methods.downloadHistoryPackage.call(app, '12345');
  assert.match(app.historyPackages['12345'].error, /incomplete history/);
});

test('loads associated updates on demand and ignores results from a previous selection', async () => {
  const app = definition.data();
  app.detailRequest = 1;
  fetchMemory = async (url) => {
    assert.equal(url, '/api/protection-keys/12345/entitlements');
    return { ok: true, json: async () => [{ id: '20', type: 3, state: 'DRAFT' }] };
  };
  await definition.methods.loadKeyUpdates.call(app, '12345');
  assert.equal(app.keyUpdates['12345'].updates[0].id, '20');
  assert.equal(app.keyUpdates['12345'].loading, false);
  fetchMemory = async () => ({ ok: false, json: async () => ({ error: 'EMS unavailable' }) });
  await definition.methods.loadKeyUpdates.call(app, '12345');
  assert.match(app.keyUpdates['12345'].error, /EMS unavailable/);
  fetchMemory = async () => {
    app.detailRequest++;
    app.keyUpdates = {};
    return { ok: true, json: async () => [{ id: '20', type: 3 }] };
  };
  await definition.methods.loadKeyUpdates.call(app, '12345');
  assert.equal(app.keyUpdates['12345'], undefined);
  assert.match(html, /Protection key updates/);
  assert.match(html, /@click="openEntitlementDetails\(update\)"/);
  assert.match(html, /v-for="\(entitlement, index\) in sortedEntitlements"/);
});

test('key update completion and errors publish reactive state changes', async () => {
  const app = definition.data();
  const writes = [];
  app.keyUpdates = new Proxy({}, {
    set(target, property, value) {
      writes.push({ loading: value.loading, error: value.error, count: value.updates.length });
      target[property] = value;
      return true;
    },
  });
  fetchMemory = async () => ({ ok: true, json: async () => [{ id: '20', type: 3 }] });
  await definition.methods.loadKeyUpdates.call(app, '12345');
  assert.deepEqual(writes, [
    { loading: true, error: '', count: 0 },
    { loading: false, error: '', count: 1 },
  ]);
  writes.length = 0;
  fetchMemory = async () => ({ ok: false, json: async () => ({ error: 'EMS unavailable' }) });
  await definition.methods.loadKeyUpdates.call(app, '12345');
  assert.deepEqual(writes, [
    { loading: true, error: '', count: 0 },
    { loading: false, error: 'Failed to load key updates: EMS unavailable', count: 0 },
  ]);
});

test('product key link downloads the exact key with a safe customer filename', () => {
  const { productKeyDownloadUrl, productKeyFilename } = definition.methods;
  const key = { productKeyId: '0001-ab&cd', customerName: 'Example / Co' };
  assert.equal(productKeyDownloadUrl(key.productKeyId), 'data:text/plain;charset=utf-8,0001-ab%26cd');
  assert.equal(productKeyFilename.call({}, key), 'Product Key - Example _ Co.txt');
  assert.equal(productKeyFilename.call({ selectedEntitlement: { customerName: 'Fallback' } }, { productKeyId: 'abc' }), 'Product Key - Fallback.txt');
  assert.match(html, /<a v-if="field.name === 'productKeyId'" :href="productKeyDownloadUrl\(key.productKeyId\)" :download="productKeyFilename\(key\)">/);
});

test('activates the selected generated product key and exposes the V2C download', async () => {
  const app = definition.data();
  app.selectedEntitlement = { id: '123', entState: 'PRODUCT_KEY_GENERATED' };
  app.isProductKeyGenerated = true;
  const key = { productKeyId: 'key-001' };
  const license = '<?xml version="1.0"?><hasp_info><v2c>YWJj</v2c></hasp_info>';
  let confirmation;
  confirmProduce = (message) => { confirmation = message; return true; };
  fetchMemory = async (url, options) => {
    assert.equal(url, '/api/entitlements/123/activate');
    assert.deepEqual(JSON.parse(options.body), { productKeyId: 'key-001', c2v: '<hasp_info/>' });
    return { ok: true, json: async () => ({ aid: 'aid-1', license }) };
  };
  const event = { target: { files: [{ name: 'machine.c2v', size: 12, text: async () => '<hasp_info/>' }], value: 'file' } };
  await definition.methods.activateProductKey.call(app, key, event);
  assert.match(confirmation, /Activate product key key-001 using the selected C2V file/);
  assert.equal(app.activationDownloads[0].license, license);
  assert.equal(definition.methods.licenseDownloadUrl(license), 'data:application/xml;charset=utf-8,' + encodeURIComponent(license));
  assert.equal(event.target.value, '');
  assert.match(html, /<details v-if="isProductKeyGenerated" class="detail-collapsible product-key-details">[\s\S]*?@change="activateProductKey\(key, \$event\)"[\s\S]*?Download V2C[\s\S]*?<\/details>/);
});

test('blocks invalid files and prevents retries after an uncertain activation', async () => {
  const app = definition.data();
  app.selectedEntitlement = { id: '123', entState: 'PRODUCT_KEY_GENERATED' };
  app.isProductKeyGenerated = true;
  const key = { productKeyId: 'key-001' };
  let calls = 0;
  fetchMemory = async () => { calls++; throw new Error('connection lost'); };
  const event = (file) => ({ target: { files: [file], value: 'file' } });
  await definition.methods.activateProductKey.call(app, key, event({ name: 'wrong.txt', size: 1 }));
  assert.match(app.activationError, /C2V/);
  assert.equal(calls, 0);
  const file = { name: 'machine.c2v', size: 12, text: async () => '<hasp_info/>' };
  confirmProduce = () => false;
  await definition.methods.activateProductKey.call(app, key, event(file));
  assert.equal(calls, 0);
  confirmProduce = () => true;
  await definition.methods.activateProductKey.call(app, key, event(file));
  assert.equal(calls, 1);
  assert.equal(app.activationUncertainKeys.includes('key-001'), true);
  await definition.methods.activateProductKey.call(app, key, event(file));
  assert.equal(calls, 1);
});

test('shows EMS diagnostic details while retaining the uncertain outcome warning', async () => {
  const app = definition.data();
  app.selectedEntitlement = { id: '123', entState: 'PRODUCT_KEY_GENERATED' };
  app.isProductKeyGenerated = true;
  fetchMemory = async () => ({
    ok: false,
    json: async () => ({ error: 'EMS activation returned HTTP 400. EMS response: Invalid fingerprint', outcomeUnknown: true }),
  });
  const file = { name: 'machine.c2v', size: 12, text: async () => '<hasp_info/>' };
  await definition.methods.activateProductKey.call(app, { productKeyId: 'key-001' }, { target: { files: [file] } });
  assert.match(app.activationError, /HTTP 400.*Invalid fingerprint/);
  assert.equal(app.activationUncertainKeys.includes('key-001'), true);
});

function versionFor(products, baseProductId = '6047') {
  const app = { selectedEntitlement: { products, baseProductId } };
  Object.defineProperty(app, 'baseMemorySegments', {
    get: () => definition.computed.baseMemorySegments.call(app),
  });
  return definition.computed.decodedVersion.call(app);
}

test('only draft entitlements can open the edit form', () => {
  const app = { isDraftEntitlement: definition.methods.isDraftEntitlement };
  const previousAssign = pageLocation.assign;
  let destination;
  pageLocation.assign = (url) => { destination = url; };
  try {
    for (const state of ['PRODUCT_KEY_GENERATED', 'QUEUED', 'PRODUCED', '', undefined]) {
      const entitlement = { id: '123', state };
      assert.equal(app.isDraftEntitlement(entitlement), false);
      definition.methods.openEditEntitlement.call(app, entitlement);
      assert.equal(destination, undefined);
    }
    assert.equal(app.isDraftEntitlement({ state: 'draft' }), true);
    definition.methods.openEditEntitlement.call(app, { id: '123', state: 'DRAFT' });
    assert.equal(destination, '/update-entitlement-form.html?id=123');
  } finally {
    pageLocation.assign = previousAssign;
  }
  assert.match(html, /:disabled="!isDraftEntitlement\(entitlement\) \|\| producing \|\| activating" @click="openEditEntitlement\(entitlement\)">Edit<\/button>/);
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(styles, /\.entitlements-page \.entitlement-row \.entitlement-actions button:disabled \{[^}]*display:\s*none/);
});

test('lists generated Product Key entitlements alongside other states', async () => {
  assert.doesNotMatch(html, />More options<\/button>/);
  const entries = [
    { id: '1', state: 'PRODUCT_KEY_GENERATED', type: 2 },
    { id: '2', state: 'DRAFT', type: 2 },
  ];
  fetchMemory = async () => ({ ok: true, json: async () => entries });
  const app = {
    selectedEntitlement: null,
    openEntitlementDetails: async (entitlement) => { app.selectedEntitlement = entitlement; },
  };
  await definition.methods.loadEntitlements.call(app);
  assert.deepEqual(app.entitlements, entries);
  assert.equal(app.selectedEntitlement.id, '1');
  assert.equal(app.error, '');
});

test('entitlement list rows use compact spacing without wrapping cell contents', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.doesNotMatch(styles, /\.entitlements-page \.entitlement-row \{[^}]*height:/);
  assert.match(styles, /\.entitlements-page \.entitlement-row > td \{[^}]*white-space:\s*nowrap/);
  assert.match(styles, /\.entitlements-page \.entitlement-row > td \{[^}]*padding:\s*0\.5em \.6rem/);
  assert.match(styles, /\.entitlements-page \.entitlement-row \.entitlement-actions button \{[^}]*padding:\s*\.15rem \.5rem/);
});

test('labels entitlement types and allows filtering by key update', () => {
  const { typeLabel } = definition.methods;
  assert.equal(typeLabel(1), 'HL Key');
  assert.equal(typeLabel('2'), 'Product Key');
  assert.equal(typeLabel(3), 'Key Update');
  assert.equal(typeLabel(' 3 '), 'Key Update');
  assert.equal(typeLabel(4), 4);
  assert.ok(definition.data().entitlementSortColumns.some((column) => column.key === 'type' && column.label === 'Type'));
  assert.match(html, /<td><template v-for="\(part, partIndex\) in highlightParts\(typeLabel\(entitlement\.type\)\)"/);
  const app = { filter: 'key update', entitlements: [{ id: '1', type: 3 }, { id: '2', type: 2 }], typeLabel };
  assert.equal(definition.computed.filteredEntitlements.call(app)[0].id, '1');
  assert.equal(definition.computed.filteredEntitlements.call(app).length, 1);
});

test('places the entitlement search in a collapsible section above the list', () => {
  assert.match(html, /<details class="detail-collapsible search-filter"[^>]*>\s*<summary>\s*<span>Search and Filter<\/span>[\s\S]*?<\/summary>\s*<div class="search-filter-controls">\s*<label>Search:\s*<input v-model\.trim="filter" class="entitlement-filter" type="search"[^>]*>\s*<\/label>\s*<div class="search-filter-options">\s*<div class="search-filter-dropdowns">[\s\S]*?<\/details>\s*<div class="table-wrap entitlement-list">/);
});

test('reset button clears all filters without changing the sort', () => {
  const app = { filter: 'Acme', visibleEntitlementType: 'key-update', visibleStatus: 'COMPLETED', createdFrom: '2026-01-01', createdTo: '2026-02-01', sortColumn: 'customer', sortDirection: 'descending' };
  definition.methods.resetEntitlementFilters.call(app);
  assert.deepEqual(app, { filter: '', visibleEntitlementType: '', visibleStatus: '', createdFrom: '', createdTo: '', sortColumn: 'customer', sortDirection: 'descending' });
  assert.match(html, /<summary>\s*<span>Search and Filter<\/span>\s*<button v-if="hasActiveFilters" type="button" class="search-filter-reset"\s*@click\.stop="resetEntitlementFilters" @keydown\.stop>Reset<\/button>\s*<\/summary>/);
});

test('persists and restores entitlement filters, including resets', () => {
  const previousStorage = pageWindow.localStorage;
  const storage = new Map();
  pageWindow.localStorage = {
    getItem: (key) => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, value),
  };
  try {
    const app = {
      filter: 'Acme', visibleEntitlementType: 'key-update', visibleStatus: 'COMPLETED',
      createdFrom: '2026-01-01', createdTo: '2026-02-01',
      saveFilterPreferences: definition.methods.saveFilterPreferences,
    };
    definition.watch.filterPreferences.call(app, definition.computed.filterPreferences.call(app));
    const restored = {
      ...definition.data(),
      loadFilterPreferences: definition.methods.loadFilterPreferences,
      loadEntitlements() { assert.equal(this.filter, 'Acme'); },
      loadCustomers() {},
    };
    definition.mounted.call(restored);
    for (const field of ['filter', 'visibleEntitlementType', 'visibleStatus', 'createdFrom', 'createdTo']) {
      assert.equal(restored[field], app[field]);
    }
    assert.equal(restored.filterStorageError, '');
    assert.ok(definition.computed.entitlementStatuses.call(restored).includes('COMPLETED'));

    definition.methods.resetEntitlementFilters.call(app);
    definition.watch.filterPreferences.call(app, definition.computed.filterPreferences.call(app));
    definition.methods.loadFilterPreferences.call(restored);
    assert.equal(definition.computed.hasActiveFilters.call(restored), false);
  } finally {
    pageWindow.localStorage = previousStorage;
  }
});

test('reports invalid saved filters and unavailable browser storage', () => {
  const previousStorage = pageWindow.localStorage;
  const app = { ...definition.data() };
  try {
    for (const value of ['not json', JSON.stringify({ filter: 'x', visibleEntitlementType: 'other', visibleStatus: '', createdFrom: '', createdTo: '' }), JSON.stringify({ filter: 'x', visibleEntitlementType: '', visibleStatus: '', createdFrom: '2026-02-30', createdTo: '' })]) {
      pageWindow.localStorage = { getItem: () => value };
      definition.methods.loadFilterPreferences.call(app);
      assert.match(app.filterStorageError, /Unable to load saved filters/);
      assert.equal(app.filter, '');
    }
    pageWindow.localStorage = {
      getItem() { throw new Error('Storage disabled'); },
      setItem() { throw new Error('Storage disabled'); },
    };
    definition.methods.loadFilterPreferences.call(app);
    assert.match(app.filterStorageError, /Unable to load saved filters: Storage disabled/);
    definition.methods.saveFilterPreferences.call(app, definition.computed.filterPreferences.call(app));
    assert.match(app.filterStorageError, /Unable to save filters in this browser: Storage disabled/);
    assert.match(html, /v-if="filterStorageError" class="form-error" role="alert"/);
  } finally {
    pageWindow.localStorage = previousStorage;
  }
});

test('shows the selected entitlement type while combining it with search', () => {
  const app = {
    filter: '', visibleEntitlementType: '',
    typeLabel: definition.methods.typeLabel, typeMarkerClass: definition.methods.typeMarkerClass,
    entitlements: [
      { id: 'a', type: 2, customer: 'Acme' },
      { id: 'b', type: ' 3 ', customer: 'Acme' },
      { id: 'c', type: 1, customer: 'Other' },
    ],
  };
  const ids = () => Array.from(definition.computed.filteredEntitlements.call(app), (entry) => entry.id);
  assert.equal(definition.data().visibleEntitlementType, '');
  assert.deepEqual(ids(), ['a', 'b', 'c']);
  app.visibleEntitlementType = 'product-key';
  assert.deepEqual(ids(), ['a']);
  app.visibleEntitlementType = 'key-update';
  assert.deepEqual(ids(), ['b']);
  app.filter = 'acme';
  assert.deepEqual(ids(), ['b']);
  app.filter = 'other';
  assert.deepEqual(ids(), []);
  app.filter = 'acme';
  app.visibleEntitlementType = '';
  assert.deepEqual(ids(), ['a', 'b']);
  assert.match(html, /<label>Show key type:\s*<select v-model="visibleEntitlementType" :class="\{ 'filter-active': visibleEntitlementType \}">\s*<option value="">All<\/option>\s*<option value="key-update">Key Update<\/option>\s*<option value="product-key">Product Key<\/option>/);
  assert.match(html, /hasActiveFilters \? 'No matching entitlements\.'/);
});

test('filters by inclusive UTC created dates along with the other filters', () => {
  const app = {
    filter: '', visibleEntitlementType: '', visibleStatus: '', createdFrom: '', createdTo: '',
    ...definition.methods,
    entitlements: [
      { id: 'a', type: 2, state: 'DRAFT', customer: 'Acme', createDate: '2026-01-31T23:59:59Z' },
      { id: 'b', type: 2, state: 'DRAFT', customer: 'Acme', createDate: '2026-02-01T10:00:00+13:00' },
      { id: 'c', type: 2, state: 'DRAFT', customer: 'Acme', createDate: '2026-02-01T23:59:59Z' },
      { id: 'd', type: 3, state: 'COMPLETED', customer: 'Other', createDate: '2026-02-02' },
      { id: 'e', type: 2, state: 'DRAFT', customer: 'Acme', createDate: 'invalid' },
      { id: 'f', type: 2, state: 'DRAFT', customer: 'Acme', createDate: '2026-02-30' },
    ],
  };
  const ids = () => Array.from(definition.computed.filteredEntitlements.call(app), (entry) => entry.id);
  assert.equal(definition.computed.hasActiveFilters.call(app), false);
  assert.deepEqual(ids(), ['a', 'b', 'c', 'd', 'e', 'f']);
  app.createdFrom = '2026-01-31';
  app.createdTo = '2026-02-01';
  assert.equal(definition.computed.hasActiveFilters.call(app), true);
  assert.deepEqual(ids(), ['a', 'b', 'c']);
  app.createdFrom = '';
  assert.deepEqual(ids(), ['a', 'b', 'c']);
  app.createdFrom = '2026-02-01';
  app.createdTo = '';
  assert.deepEqual(ids(), ['c', 'd']);
  app.visibleEntitlementType = 'product-key';
  app.visibleStatus = 'DRAFT';
  app.filter = 'acme';
  assert.deepEqual(ids(), ['c']);
  app.createdFrom = '2026-02-03';
  app.createdTo = '2026-02-01';
  assert.equal(definition.computed.invalidDateRange.call(app), true);
  assert.deepEqual(ids(), []);
  assert.match(html, /Created from \(UTC\):\s*<input v-model="createdFrom" type="date" :class="\{ 'filter-active': createdFrom \}"/);
  assert.match(html, /Created to \(UTC\):\s*<input v-model="createdTo" type="date" :class="\{ 'filter-active': createdTo \}"/);
  assert.match(html, /v-if="invalidDateRange" id="date-range-error" class="form-error" role="alert"/);
});

test('filters by available status together with key type and search', () => {
  const app = {
    filter: '', visibleEntitlementType: '', visibleStatus: '',
    typeLabel: definition.methods.typeLabel, typeMarkerClass: definition.methods.typeMarkerClass,
    entitlements: [
      { id: 'a', type: 2, state: 'DRAFT', customer: 'Acme' },
      { id: 'b', type: 3, state: 'COMPLETED', customer: 'Acme' },
      { id: 'c', type: 2, state: 'COMPLETED', customer: 'Other' },
      { id: 'd', type: 2, state: 'NEW_STATE', customer: 'Acme' },
      { id: 'e', type: 1, customer: 'Acme' },
    ],
  };
  const ids = () => Array.from(definition.computed.filteredEntitlements.call(app), (entry) => entry.id);
  assert.equal(definition.data().visibleStatus, '');
  assert.deepEqual(Array.from(definition.computed.entitlementStatuses.call(app)), ['COMPLETED', 'DRAFT', 'NEW_STATE']);
  app.visibleStatus = 'COMPLETED';
  assert.deepEqual(ids(), ['b', 'c']);
  app.visibleEntitlementType = 'product-key';
  assert.deepEqual(ids(), ['c']);
  app.filter = 'acme';
  assert.deepEqual(ids(), []);
  app.visibleEntitlementType = '';
  assert.deepEqual(ids(), ['b']);
  app.visibleStatus = '';
  assert.deepEqual(ids(), ['a', 'b', 'd', 'e']);
  app.visibleStatus = 'MISSING';
  assert.ok(definition.computed.entitlementStatuses.call(app).includes('MISSING'));
  assert.deepEqual(ids(), []);
  assert.match(html, /<label>Show status:\s*<select v-model="visibleStatus" :class="\{ 'filter-active': visibleStatus \}">\s*<option value="">All<\/option>\s*<option v-for="status in entitlementStatuses" :key="status" :value="status" :class="statusTagClass\(status\)">\{\{ status \}\}<\/option>/);
});

test('highlights active search and filters with a cycling diagonal gradient', () => {
  assert.match(html, /<input v-model\.trim="filter" class="entitlement-filter" type="search"\s*:class="\{ 'filter-active': filter \}"/);
  assert.match(html, /<details class="detail-collapsible search-filter" :class="\{ 'filter-active': hasActiveFilters \}">/);
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(styles, /\.search-filter\.filter-active \{\s*border: 1px solid transparent;/);
  assert.match(styles, /linear-gradient\(to bottom right in hsl increasing hue, hsl\(var\(--active-filter-hue\) 100% 50%\), hsl\(calc\(var\(--active-filter-hue\) \+ 180deg\) 100% 50%\)\) border-box/);
  assert.match(styles, /animation: active-filter-rainbow 3s linear infinite/);
  assert.match(styles, /@keyframes active-filter-rainbow \{\s*from \{ --active-filter-hue: 0deg; \}\s*to \{ --active-filter-hue: 360deg; \}/);
  assert.match(styles, /\.entitlements-page \.search-filter-controls :is\(input, select\)\.filter-active,\s*\.entitlements-page \.entitlement-list-panel \.search-filter\.filter-active \{/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{\s*\.entitlements-page \.search-filter-controls :is\(input, select\)\.filter-active,\s*\.entitlements-page \.entitlement-list-panel \.search-filter\.filter-active \{ animation: none; \}/);
});

test('colors filter options to match entitlement markers and status tags', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  for (const [value, color] of [['product-key', 'product-key'], ['key-update', 'key-update']]) {
    assert.ok(styles.includes(`option[value="${value}"] { background: var(--entitlement-${color}-color); color: #000; }`));
  }
  for (const status of ['complete', 'draft', 'acknowledged', 'queued', 'produced', 'unknown']) {
    assert.ok(styles.includes(`.status-tag.status-${status}, .entitlements-page .search-filter-controls option.status-${status} { background: var(--status-${status}-bg); color: var(--status-${status}-text); }`));
  }
  assert.equal(definition.methods.statusTagClass('COMPLETED'), 'status-complete');
  assert.equal(definition.methods.statusTagClass('PRODUCT_KEY_GENERATED'), 'status-unknown');
});

test('sorts filtered entitlements by each data column and toggles direction', () => {
  const entries = [
    { id: 'a', type: 2, createDate: '2026-02-01T10:00:00+13:00', customer: 'Zebra', refId1: '10', state: 'QUEUED' },
    { id: 'b', type: 3, createDate: '2026-01-31T20:00:00Z', customer: 'apple', refId1: '2', state: 'DRAFT' },
    { id: 'c', type: null, createDate: null, customer: null, refId1: null, state: null },
  ];
  const app = {
    filteredEntitlements: entries, sortColumn: '', sortDirection: 'ascending',
    typeLabel: definition.methods.typeLabel,
  };
  const ids = () => Array.from(definition.computed.sortedEntitlements.call(app), (entry) => entry.id);
  const sort = (column) => definition.methods.sortEntitlements.call(app, column);
  assert.deepEqual(ids(), ['a', 'b', 'c']);
  for (const column of ['type', 'createDate', 'customer', 'refId1', 'state']) {
    sort(column);
    assert.equal(app.sortDirection, 'ascending');
    assert.deepEqual(ids(), ['b', 'a', 'c'], column);
    sort(column);
    assert.equal(app.sortDirection, 'descending');
    assert.deepEqual(ids(), ['a', 'b', 'c'], column);
    sort(column);
    assert.equal(app.sortDirection, 'ascending');
    assert.deepEqual(ids(), ['b', 'a', 'c'], column);
  }
  assert.deepEqual(entries.map((entry) => entry.id), ['a', 'b', 'c']);
  app.filter = 'key update';
  app.entitlements = entries;
  app.filteredEntitlements = definition.computed.filteredEntitlements.call(app);
  assert.deepEqual(ids(), ['b']);
  assert.match(html, /<th v-for="column in entitlementSortColumns"[^>]*:aria-sort="sortColumn === column.key \? sortDirection : null"[^>]*:title="'Sort ' \+ column.label \+ ' ' \+ \(sortColumn === column.key && sortDirection === 'ascending' \? 'descending' : 'ascending'\)"[^>]*@click="sortEntitlements\(column.key\)">\s*<button type="button" class="entitlement-sort">/);
  assert.match(html, /v-for="\(entitlement, index\) in sortedEntitlements"/);
  assert.match(html, /<th>Actions<\/th>/);
});

test('keeps invalid dates last and equal sort values in their original order', () => {
  const app = {
    filteredEntitlements: [
      { id: 'a', createDate: 'invalid' },
      { id: 'b', createDate: '2026-01-01' },
      { id: 'c', createDate: '2026-01-01' },
      { id: 'd', createDate: '' },
    ],
    sortColumn: 'createDate', sortDirection: 'descending',
  };
  assert.deepEqual(Array.from(definition.computed.sortedEntitlements.call(app), (entry) => entry.id), ['b', 'c', 'a', 'd']);
});

test('marks entitlement types with an accessible thin color cell', () => {
  const { typeMarkerClass } = definition.methods;
  assert.equal(typeMarkerClass(2), 'product-key');
  assert.equal(typeMarkerClass(' 3 '), 'key-update');
  assert.equal(typeMarkerClass(1), 'other');
  assert.match(html, /<th class="entitlement-type-header" aria-label="Entitlement type"><\/th>/);
  assert.match(html, /class="entitlement-type-marker" :class="typeMarkerClass\(entitlement.type\)" :title="displayValue\(typeLabel\(entitlement.type\)\)" :aria-label="displayValue\(typeLabel\(entitlement.type\)\)"/);
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(styles, /td\.entitlement-type-marker \{ width: \.5rem; min-width: \.5rem; padding: 0; \}/);
  assert.match(styles, /--entitlement-product-key-color: #00ffff/);
  assert.match(styles, /--entitlement-key-update-color: #ff00ff/);
  assert.match(styles, /td\.entitlement-type-marker\.product-key \{ background: var\(--entitlement-product-key-color\); \}/);
  assert.match(styles, /td\.entitlement-type-marker\.key-update \{ background: var\(--entitlement-key-update-color\); \}/);
});

test('shows entitlement dates in local time with date-only values unchanged', () => {
  const { formatLocalDate, displayValue } = definition.methods;
  const dateTime = '2026-11-12T09:00:00+13:00';
  const localDate = new Date(dateTime);
  const expectedLocal = `${String(localDate.getDate()).padStart(2, '0')}-${String(localDate.getMonth() + 1).padStart(2, '0')}-${localDate.getFullYear()}`;
  assert.equal(formatLocalDate.call({ displayValue }, dateTime), expectedLocal);
  assert.equal(formatLocalDate.call({ displayValue }, '2026-11-12T09:00:00'), expectedLocal);
  assert.equal(formatLocalDate.call({ displayValue }, '2026-11-12'), '12-11-2026');
  assert.equal(formatLocalDate.call({ displayValue }, null), '—');
  assert.ok(definition.data().entitlementSortColumns.some((column) => column.key === 'createDate' && column.label === 'Created Date'));
  assert.match(html, /:title="entitlement\.createDate \? 'UTC, DD-MM-YYYY' : null"[^>]*>[\s\S]*?highlightParts\(formatUtcDate\(entitlement\.createDate\)\)/);
  assert.match(html, /Created Date<\/div>\s*<div class="detail-value" role="cell" :title="selectedEntitlement\.createDate \? 'UTC, DD-MM-YYYY' : null">\{\{ formatUtcDate\(selectedEntitlement\.createDate\) \}\}/);
  assert.match(html, /Start Date<\/div>\s*<div class="detail-value" role="cell" :title="selectedEntitlement\.startDate \? 'Local time, DD-MM-YYYY' : null">\{\{ formatLocalDate\(selectedEntitlement\.startDate\) \}\}/);
  assert.ok(html.includes('{{ formatEndDate(selectedEntitlement.endDate) }}'));
  assert.ok(html.includes(':title="/^\\d{4}-\\d{2}-\\d{2}$/.test(selectedExpiryDate) ? \'Local time, DD-MM-YYYY\' : null">{{ formatLocalDate(selectedExpiryDate) }}'));
  const app = { displayValue, formatLocalDate };
  assert.equal(definition.methods.formatUtcDate.call(app, '2026-11-12T09:00:00+13:00'), '11-11-2026');
  assert.equal(definition.methods.formatUtcDate.call(app, '2026-11-12'), '12-11-2026');
  assert.equal(definition.methods.formatEndDate.call(app, '2500-12-31'), 'Never');
  assert.equal(definition.methods.formatEndDate.call(app, '2500-12-30'), '30-12-2500');
  assert.equal(definition.methods.formatEndDate.call(app, null), '—');
  assert.equal(formatLocalDate.call(app, '2024-02-29'), '29-02-2024');
  assert.equal(formatLocalDate.call(app, 'N/A (Not Lease)'), 'N/A (Not Lease)');
  assert.equal(formatLocalDate.call(app, 'Unavailable'), 'Unavailable');
});

test('shows customer, serial number, and expiry date in order in entitlement details', () => {
  assert.ok(definition.data().entitlementSortColumns.some((column) => column.key === 'refId1' && column.label === 'Irricad Order Code (Ref ID 1)'));
  const details = html.match(/<div class="entitlement-detail-fields"[^>]*>([\s\S]*?)<\/div>\s*<div v-if="!isKeyUpdate \|\| canProduce" class="detail-footer"/)[1];
  const labels = [...details.matchAll(/<div class="detail-label" role="rowheader"[^>]*>(.*?)<\/div>/g)].map((match) => match[1]);
  assert.doesNotMatch(details, /<input type="checkbox"/);
  assert.match(html, /<div v-if="!isKeyUpdate \|\| canProduce" class="detail-footer">\s*<p v-if="!isKeyUpdate" class="detail-footnote">[\s\S]*?<\/p>\s*<div v-if="canProduce" class="detail-actions">\s*<button type="button"[^>]*>I have checked these<\/button>\s*<button type="button" class="button--constructive"[^>]*:disabled="!detailsConfirmed/);
  assert.deepEqual(labels, ['Customer', 'Serial Number*', 'Irricad Order Code (Ref ID 1)', 'Created Date', 'Start Date', 'End Date', 'Standalone Irricad', 'Link Irricad', 'Pivot Irricad', 'Lease Irricad', 'Lease Expiry Date*', 'Irricad Version*']);
  assert.match(details, /Irricad Order Code \(Ref ID 1\)<\/div>\s*<div class="detail-value" role="cell">\{\{ displayValue\(selectedEntitlement\.refId1\) \}\}/);
  const app = { selectedEntitlement: {
    baseProductId: '6047',
    leaseProductId: '6050',
    products: [
      { productId: '6047', memorySegments: [
        { name: 'Serial Number', saot: true, text: '344432' },
        { name: 'Expiry Date', saot: true, text: '35383544' },
      ] },
      { productId: '6050', memorySegments: [] },
    ],
  } };
  Object.defineProperty(app, 'baseMemorySegments', {
    get: () => definition.computed.baseMemorySegments.call(app),
  });
  assert.equal(definition.computed.selectedSerialNumber.call(app), '01234');
  assert.equal(definition.computed.selectedExpiryDate.call(app), '2024-02-29');
  app.selectedEntitlement.products[0].memorySegments[1].text = '585D';
  assert.equal(definition.computed.selectedExpiryDate.call(app), '2024-02-29');
  app.selectedEntitlement.products[0].memorySegments[1].text = '0000585D';
  assert.equal(definition.computed.selectedExpiryDate.call(app), '2024-02-29');
  app.selectedEntitlement.products[0].memorySegments[1].text = '35383544';
  app.selectedEntitlement.products.pop();
  assert.equal(definition.computed.selectedExpiryDate.call(app), 'N/A (Not Lease)');
  app.selectedEntitlement.products[0].memorySegments = [];
  assert.equal(definition.computed.selectedSerialNumber.call(app), 'Unavailable');
  app.selectedEntitlement.products.push({ productId: '6050', memorySegments: [] });
  assert.equal(definition.computed.selectedExpiryDate.call(app), 'Unavailable');
});

test('marks malformed or invalid base expiry dates unavailable', () => {
  const app = {
    selectedEntitlement: { leaseProductId: '6050', products: [{ productId: '6050' }] },
    baseMemorySegments: [{ name: 'Expiry Date', saot: true, text: '30303030' }],
  };
  assert.equal(definition.computed.selectedExpiryDate.call(app), 'Unavailable');
  app.baseMemorySegments[0].text = '35383230';
  assert.equal(definition.computed.selectedExpiryDate.call(app), 'Unavailable');
});

test('verbose memory shows EMS access and ASCII-decoded values', () => {
  const { memoryAccess, asciiHexValue, hexValue, displayValue } = definition.methods;
  const app = { hexValue, displayValue };
  assert.match(html, /<th>Memory access<\/th><th>Value<\/th><th>Value \(ASCII hex\)<\/th>/);
  assert.equal(memoryAccess({ memoryTypes: ['1'] }), 'R/W');
  assert.equal(memoryAccess({ memoryTypes: ['2'] }), 'RO');
  assert.equal(memoryAccess({ memoryTypes: ['1', '2'] }), 'R/W, RO');
  assert.equal(memoryAccess({ memoryTypes: ['1', '3'] }), 'Unavailable');
  assert.equal(memoryAccess({}), 'Unavailable');
  assert.equal(asciiHexValue.call(app, { text: '30304432', size: 4 }), '00D2');
  assert.equal(asciiHexValue.call(app, { text: '000AFF41', size: 4 }), '\\x00\\x0A\\xFFA');
  assert.equal(asciiHexValue.call(app, { text: '', size: 4 }), 'Unavailable');
  assert.equal(asciiHexValue.call(app, { text: 'abcdz', size: 4 }), 'Unavailable');
  assert.equal(asciiHexValue.call(app, { text: 'abc' }), 'Unavailable');
});

test('shows each configured product alias as present or absent', () => {
  assert.match(html, /<div class="detail-value"[^>]*>\{\{ productPresent\('standalone'\) \}\}<\/div>/);
  const app = { selectedEntitlement: {
    products: [{ productId: '6048' }, { productId: '6052' }],
    productAliases: [
      { alias: 'standalone', id: '6048', group: 'product' },
      { alias: 'link', id: '6049', group: 'product' },
      { alias: 'v22', id: '', group: 'version' },
      { alias: 'v23', id: '6052', group: 'version' },
      { alias: 'lease', id: '6050', group: 'lease' },
    ],
  } };
  assert.deepEqual(
    definition.computed.selectedProductAttributes.call(app).map(({ alias, present }) => ({ alias, present })),
    [
      { alias: 'standalone', present: true },
      { alias: 'link', present: false },
      { alias: 'lease', present: false },
    ]
  );
  assert.ok(!html.includes('>End date<'));
});

test('shows the decoded base product version in entitlement details', () => {
  assert.match(html, /<div class="detail-label"[^>]*>Irricad Version\*<\/div>\s*<div class="detail-value"[^>]*>\{\{ decodedVersion \}\}<\/div>/);
  const products = [
    { productId: '6048', memorySegments: [{ name: 'Version', text: '30303030' }] },
    { productId: '6047', memorySegments: [{ name: ' Version ', text: '45423544' }] },
  ];
  assert.equal(versionFor(products), 'v22');
  products[1].memorySegments[0].text = '45373735';
  assert.equal(versionFor(products), 'v23');
  products[1].memorySegments[0].text = '42454144';
  assert.equal(versionFor(products), 'v0');
  products[1].memorySegments[0].text = '45353435';
  assert.equal(versionFor(products), 'v23.528');
});

test('distinguishes missing and invalid version memory', () => {
  assert.equal(versionFor([]), 'Unavailable');
  assert.equal(versionFor([{ productId: '6047', memorySegments: [] }]), 'Unavailable');
  for (const text of ['', '0', '4542354Z', '47423544', '4542354441']) {
    assert.equal(versionFor([{ productId: '6047', memorySegments: [{ name: 'Version', text }] }]), 'Invalid version data');
  }
  assert.equal(versionFor([{ productId: '6047', memorySegments: [
    { name: 'Version', text: '45423544' },
    { name: 'version', text: '45423544' },
  ] }]), 'Invalid version data');
});

test('uses the selected version modification memory rather than the base default', async () => {
  const entitlement = {
    baseProductId: '6047',
    versionProductIds: ['6052'],
    products: [
      { productId: '6047', memorySegments: [{ name: 'Version', offset: 0, size: 4, text: '45423544' }] },
      { productId: '6052' },
    ],
  };
  fetchMemory = async (url) => {
    assert.equal(url, '/api/catalog/products/6052/read-only-memory');
    return { ok: true, json: async () => [{ kind: 'product', segments: [
      { offset: '0x0000', size: '4', content: '45373735', saot: false },
    ] }] };
  };
  const memory = await definition.methods.loadVersionMemory(entitlement);
  const app = { baseMemorySegments: entitlement.products[0].memorySegments, versionMemory: memory };
  assert.equal(definition.computed.decodedVersion.call(app), 'v23');
  entitlement.products.pop();
  assert.equal(await definition.methods.loadVersionMemory(entitlement), undefined);
  app.versionMemory = null;
  assert.equal(definition.computed.decodedVersion.call(app), 'v22');
});

test('refuses ambiguous, incomplete, editable or unavailable version writes', async () => {
  const entitlement = {
    baseProductId: '6047', versionProductIds: ['6052', '6053'],
    products: [
      { productId: '6047', memorySegments: [{ name: 'Version', offset: 0, size: 4, text: '45423544' }] },
      { productId: '6052' },
    ],
  };
  const segment = { offset: '0x0000', size: '4', content: '45373735', saot: false };
  for (const writes of [[], [segment, segment], [{ ...segment, size: 2 }], [{ ...segment, saot: true }]]) {
    fetchMemory = async () => ({ ok: true, json: async () => [{ kind: 'product', segments: writes }] });
    await assert.rejects(() => definition.methods.loadVersionMemory(entitlement), /one complete fixed Version write/);
  }
  fetchMemory = async () => ({ ok: false, statusText: 'Service unavailable', json: async () => ({ error: 'EMS error' }) });
  await assert.rejects(() => definition.methods.loadVersionMemory(entitlement), /EMS error/);
  entitlement.products.push({ productId: '6053' });
  await assert.rejects(() => definition.methods.loadVersionMemory(entitlement), /multiple version products/);
});
