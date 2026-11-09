const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EmsClient } = require('../ems-client');
const { validateMemoryValues } = require('../entitlement-memory');

function clientWithResponses(responses) {
  const client = new EmsClient({ baseUrl: 'https://ems.example' });
  client.call = async (url) => {
    assert.ok(Object.hasOwn(responses, url), `Unexpected EMS request: ${url}`);
    return responses[url];
  };
  return client;
}

test('lists product-specific segments only for read-only memory files', async () => {
  const client = clientWithResponses({
    '/product/12.ws': `<product><dynamicMemoriesRef>
      <dynamicMemory><memoryId>1</memoryId><memories>
        <memorySegment><name>First</name><offset>0x0001</offset><size>2</size><content>000A</content><saot>true</saot></memorySegment>
        <memorySegment><name>Second</name><offset>0x0003</offset><size>1</size><content>00</content><saot>false</saot></memorySegment>
      </memories></dynamicMemory>
      <dynamicMemory><memoryId>2</memoryId></dynamicMemory>
      <dynamicMemory><memoryId>3</memoryId></dynamicMemory>
    </dynamicMemoriesRef></product>`,
    '/dynamicMemory/1.ws': '<dynamicMemory><memoryName>Read only</memoryName><fileId>4</fileId><memoryType>2</memoryType><memories><memorySegment><name>Default</name></memorySegment></memories></dynamicMemory>',
    '/dynamicMemory/2.ws': '<dynamicMemory><memoryName>Read write</memoryName><memoryType>1</memoryType></dynamicMemory>',
    '/dynamicMemory/3.ws': '<dynamicMemory><memoryName>Other</memoryName><fileId>5</fileId><memoryType>2</memoryType><memories><memorySegment><name>Default</name><content>0000</content><saot>false</saot></memorySegment></memories></dynamicMemory>',
  });
  const files = await client.getProductReadOnlyMemory('12');
  assert.equal(files.length, 2);
  assert.deepEqual(files[0].segments.map(({ name, content, offset }) => ({ name, content, offset })), [
    { name: 'First', content: '000A', offset: '0x0001' },
    { name: 'Second', content: '00', offset: '0x0003' },
  ]);
  assert.equal(files[1].segments[0].content, '0000');
  assert.equal(files[0].segments[0].saot, true);
  assert.equal(files[0].segments[1].saot, false);
});

test('handles no references, empty segment lists, and invalid EMS data explicitly', async () => {
  assert.deepEqual(await clientWithResponses({ '/product/1.ws': '<product><productName>None</productName></product>' }).getProductReadOnlyMemory('1'), []);
  const client = clientWithResponses({
    '/product/2.ws': '<product><dynamicMemoriesRef><dynamicMemory><memoryId>3</memoryId><memories/></dynamicMemory></dynamicMemoriesRef></product>',
    '/dynamicMemory/3.ws': '<dynamicMemory><memoryType>2</memoryType><memories><memorySegment><name>Default</name></memorySegment></memories></dynamicMemory>',
  });
  assert.deepEqual((await client.getProductReadOnlyMemory(2))[0].segments, []);
  await assert.rejects(() => client.getProductReadOnlyMemory('../2'), /positive number/);
  await assert.rejects(() => clientWithResponses({
    '/product/1.ws': '<product><dynamicMemoriesRef><dynamicMemory><memoryId>3</memoryId></dynamicMemory></dynamicMemoriesRef></product>',
    '/dynamicMemory/3.ws': '<dynamicMemory><memoryType>unknown</memoryType></dynamicMemory>',
  }).getProductReadOnlyMemory(1), /invalid details/);
});

test('lists read-only product memory segments separately from dynamic memory', async () => {
  const client = clientWithResponses({
    '/product/4.ws': `<product>
      <memorySegment><id>45</id><name>Static RO</name><text>000F</text><offset>0x0000</offset><saot>true</saot><memoryType><id>2</id></memoryType></memorySegment>
      <memorySegment><name>Static RW</name><memoryType><id>1</id></memoryType></memorySegment>
    </product>`,
  });
  const files = await client.getProductReadOnlyMemory(4);
  assert.equal(files.length, 1);
  assert.equal(files[0].kind, 'product');
  assert.equal(files[0].segments.length, 1);
  assert.equal(files[0].segments[0].name, 'Static RO');
  assert.equal(files[0].segments[0].content, '000F');
  assert.equal(files[0].segments[0].id, '45');
  assert.equal(files[0].segments[0].saot, true);
  await assert.rejects(() => clientWithResponses({
    '/product/1.ws': '<product><memorySegment><name>Unknown</name></memorySegment></product>',
  }).getProductReadOnlyMemory(1), /valid memory type/);
});

test('validates all SAOT values against current EMS metadata', () => {
  const files = { '4': [{ kind: 'product', segments: [
    { id: '45', name: 'Segment', size: '2', saot: true },
    { id: '46', size: '1', saot: false },
  ] }] };
  assert.deepEqual(validateMemoryValues(['4'], files, [{ productId: '4', segmentId: '45', content: '00af' }]),
    [{ id: '45', content: '00AF' }]);
  assert.throws(() => validateMemoryValues(['4'], files, []), /every SAOT/);
  assert.throws(() => validateMemoryValues(['4'], files, [{ productId: '4', segmentId: '45', content: 'abc' }]), /exactly 2 bytes/);
  assert.throws(() => validateMemoryValues(['4'], files, [{ productId: '4', segmentId: '46', content: '00' }]), /Unexpected/);
  assert.throws(() => validateMemoryValues(['4'], { '4': [{ kind: 'dynamic', segments: [{ saot: true }] }] }, []), /not supported/);
});

test('serializes SAOT static values in EMS entitlement memory segments', async () => {
  const client = new EmsClient({ baseUrl: 'https://ems.example' });
  client.authenticated = true;
  client.webSessionUrl = 'https://ems.example/ems/homePage';
  let body;
  client._fetch = async (_url, options) => {
    body = options.body;
    return { status: 200, ok: true, text: async () => '{"saved":true}' };
  };
  await client.createEntitlement({
    lineItemType: 'Hardware_Key', productIds: ['4'], customerId: '1', vendorId: '2',
    enforcementId: '1', startDate: '2026-01-01', endDate: '2500-12-31',
    activationsPerKey: 1, description: '', refId1: '', refId2: '',
    memorySegments: [{ id: '45', content: '00AF' }],
  });
  assert.match(body.get('entitlementXML'), /<memorySegments><segment><lineItemMemorySegmentID><\/lineItemMemorySegmentID><prdMemorySegmentId>45<\/prdMemorySegmentId><prdSuiteLineItemId><\/prdSuiteLineItemId><data>00AF<\/data><\/segment><\/memorySegments>/);
});

test('serializes Product Key type and counts in EMS requests', async () => {
  const client = new EmsClient({ baseUrl: 'https://ems.example' });
  client.authenticated = true;
  client.webSessionUrl = 'https://ems.example/ems/homePage';
  let body;
  client._fetch = async (_url, options) => {
    body = options.body;
    return { status: 200, ok: true, text: async () => '{"saved":true}' };
  };
  await client.createEntitlement({
    lineItemType: 'Product_Key', productIds: ['4'], customerId: '1', vendorId: '2',
    enforcementId: '1', startDate: '2026-01-01', endDate: '2500-12-31',
    numberOfKeys: 3, activationsPerKey: 2, description: '', refId1: '', refId2: '',
    memorySegments: [],
  });
  assert.match(body.get('entitlementXML'), /<lineItemType>Product_Key<\/lineItemType>/);
  assert.match(body.get('entitlementXML'), /<numActivationPerProductKey>2<\/numActivationPerProductKey>/);
  assert.match(body.get('entitlementXML'), /<numProductKeys>3<\/numProductKeys>/);
  assert.equal(body.get('lineItemTypeForProdPush'), 'Product_Key');
});

test('reports an EMS login redirect as an expired session', async () => {
  const client = clientWithResponses({});
  client.call = async () => { const error = new Error('Redirect'); error.status = 302; throw error; };
  await assert.rejects(() => client.getProductReadOnlyMemory(1), { status: 401 });
});

function entitlementApp(fetch) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'entitlements.html'), 'utf8');
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  let definition;
  vm.runInNewContext(script, {
    fetch,
    Vue: { createApp: (options) => { definition = options; return { mount() {} }; } },
  });
  const app = { ...definition.methods };
  Object.assign(app, definition.data.call(app));
  Object.defineProperty(app, 'availableProducts', { get: () => definition.computed.availableProducts.call(app) });
  Object.defineProperty(app, 'memoryProductIds', { get: () => definition.computed.memoryProductIds.call(app) });
  Object.defineProperty(app, 'productMemoryReady', { get: () => definition.computed.productMemoryReady.call(app) });
  return app;
}

test('adding and removing products loads their memory without stale responses', async () => {
  const pending = [];
  const app = entitlementApp((url) => new Promise((resolve) => pending.push({ url, resolve })));
  app.products = [{ productId: 12, productName: 'Product' }];
  app.form.productToAdd = '12';
  app.addProduct();
  assert.equal(pending[0].url, '/api/catalog/products/12/read-only-memory');
  assert.equal(app.productMemory['12'].loading, true);
  app.removeProduct('12');
  app.form.productToAdd = '12';
  app.addProduct();
  pending[0].resolve({ ok: true, json: async () => [{ memoryId: 'old' }] });
  await new Promise(setImmediate);
  assert.equal(app.productMemory['12'].loading, true);
  pending[1].resolve({ ok: true, json: async () => [{ memoryId: 'new', segments: [] }] });
  await new Promise(setImmediate);
  assert.equal(app.productMemory['12'].files[0].memoryId, 'new');
  assert.equal(app.productMemory['12'].loading, false);
});

test('memory lookup failures are visible and can be retried', async () => {
  let attempt = 0;
  const app = entitlementApp(async () => ++attempt === 1
    ? { ok: false, statusText: 'Bad gateway', json: async () => ({ error: 'EMS unavailable' }) }
    : { ok: true, json: async () => [] });
  await app.loadProductMemory('12');
  assert.match(app.productMemory['12'].error, /EMS unavailable/);
  await app.loadProductMemory('12');
  assert.equal(app.productMemory['12'].error, '');
  assert.equal(app.productMemory['12'].files.length, 0);
});

test('loads modification products and required base memory for creation', async () => {
  const requests = [];
  const app = entitlementApp(async (url) => {
    requests.push(url);
    return { ok: true, json: async () => url === '/api/entitlement-products'
      ? { baseProductId: '60', modifications: [{ productId: '12', productName: 'Update' }] }
      : [{ kind: 'product', segments: [{ id: '90', saot: true, content: '0000' }] }] };
  });
  await app.loadProducts();
  assert.deepEqual(requests, ['/api/entitlement-products', '/api/catalog/products/60/read-only-memory']);
  assert.equal(app.baseProductId, '60');
  assert.equal(app.availableProducts[0].productId, '12');
  assert.equal(app.productMemoryReady, true);
  assert.equal(app.productMemory['60'].files[0].segments[0].value, '0000');
});

test('form blocks saving while memory is unavailable or dynamic SAOT is unsupported', async () => {
  const app = entitlementApp(async () => ({
    ok: true, json: async () => [{ kind: 'dynamic', segments: [{ saot: true }] }],
  }));
  app.form.productIds = ['12'];
  app.baseProductId = '60';
  app.productMemory['60'] = { loading: false, error: '', files: [] };
  assert.equal(app.productMemoryReady, false);
  await app.loadProductMemory('12');
  assert.equal(app.productMemoryReady, false);
  app.productMemory['12'].files[0].segments[0].saot = false;
  assert.equal(app.productMemoryReady, true);
});

test('submits editable SAOT values without non-SAOT segments', async () => {
  let submitted;
  const app = entitlementApp(async (_url, options) => {
    submitted = JSON.parse(options.body);
    return { ok: true, json: async () => ({}) };
  });
  app.loadEntitlements = async () => {};
  app.form.productIds = ['12'];
  app.baseProductId = '60';
  app.productMemory['60'] = { loading: false, error: '', files: [
    { kind: 'product', segments: [{ id: '3', saot: true, value: '00AA' }] },
  ] };
  app.productMemory['12'] = { loading: false, error: '', files: [
    { kind: 'product', segments: [
      { id: '1', saot: true, value: '00FF' },
      { id: '2', saot: false, content: 'AA' },
    ] },
  ] };
  assert.equal(app.productMemoryReady, true);
  await app.createEntitlement();
  assert.equal(Object.hasOwn(submitted, 'enforcementId'), false);
  assert.equal(Object.hasOwn(submitted, 'lineItemType'), false);
  assert.equal(Object.hasOwn(submitted, 'startDate'), false);
  assert.equal(Object.hasOwn(submitted, 'neverExpires'), false);
  assert.equal(Object.hasOwn(submitted, 'endDate'), false);
  assert.equal(Object.hasOwn(submitted, 'numberOfKeys'), false);
  assert.equal(Object.hasOwn(submitted, 'activationsPerKey'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(submitted.memoryValues)), [
    { productId: '60', segmentId: '3', content: '00AA' },
    { productId: '12', segmentId: '1', content: '00FF' },
  ]);
});
