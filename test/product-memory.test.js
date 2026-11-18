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

test('uses entitlement item memory values for product memory segments', async () => {
  const client = clientWithResponses({
    '/entitlement/5057.xml': `<entitlement><customerId>5</customerId><entitlementItem>
      <memorySegments><segment><prdMemorySegmentId>90</prdMemorySegmentId><data>35383544</data></segment></memorySegments>
      <itemProduct><productId>6047</productId><product><productName>Base</productName>
        <memorySegment><id>90</id><name>Expiry Date</name><size>4</size><text>30303030</text><saot>true</saot><memoryType><id>2</id></memoryType></memorySegment>
        <memorySegment><id>91</id><name>Writable</name><size>1</size><text>41</text><saot>false</saot><memoryType><id>1</id></memoryType></memorySegment>
        <memorySegment><id>92</id><name>Unspecified</name><size>1</size><text>00</text><saot>false</saot></memorySegment>
      </product></itemProduct>
    </entitlementItem></entitlement>`,
  });
  const details = await client.getEntitlementDetails('5057', { includeCustomer: false });
  assert.equal(details.products[0].memorySegments[0].text, '35383544');
  assert.deepEqual(details.products[0].memorySegments.map((segment) => segment.memoryTypes), [['2'], ['1'], []]);
});

test('preserves leading zeroes in saved memory values', async () => {
  const client = clientWithResponses({
    '/entitlement/1.xml': `<entitlement><customerId>5</customerId><entitlementItem>
      <memorySegments><segment><prdMemorySegmentId>90</prdMemorySegmentId><data>00000010</data></segment></memorySegments>
      <itemProduct><productId>60</productId><product><memorySegment><id>90</id><saot>true</saot><text>00000000</text></memorySegment></product></itemProduct>
    </entitlementItem></entitlement>`,
    '/customer.xml': '<listResponse></listResponse>',
  });
  assert.equal((await client.getEntitlementDetails('1')).products[0].memorySegments[0].text, '00000010');
});

test('preserves numeric order codes when listing and loading entitlements', async () => {
  const client = clientWithResponses({
    '/entitlement.xml': '<listResponse><instance><id>1</id><refId1>00123</refId1></instance></listResponse>',
    '/entitlement/1.xml': '<entitlement><customerId>5</customerId><refId1>00123</refId1></entitlement>',
    '/customer.xml': '<listResponse></listResponse>',
  });
  assert.equal((await client.listEntitlements())[0].refId1, '00123');
  assert.equal((await client.getEntitlementDetails('1')).refId1, '00123');
});

test('preserves numeric product key IDs when loading entitlements', async () => {
  const client = clientWithResponses({
    '/entitlement/1.xml': '<entitlement><customerId>5</customerId><entitlementItem><productKeyId>00123</productKeyId></entitlementItem></entitlement>',
    '/customer.xml': '<listResponse></listResponse>',
  });
  assert.equal((await client.getEntitlementDetails('1')).entitlementItem.productKeyId, '00123');
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
    enforcementId: '1', createDate: '2026-11-12T10:06:31.204+13:00',
    startDate: '2026-01-01', endDate: '2500-12-31',
    activationsPerKey: 1, description: '', refId1: 'Order & 123', refId2: '',
    memorySegments: [{ id: '45', content: '00AF' }],
  });
  assert.equal((body.get('entitlementXML').match(/<createDate>2026-11-12T10:06:31\.204\+13:00<\/createDate>/g) || []).length, 1);
  assert.equal((body.get('entitlementXML').match(/<startDate>2026-01-01<\/startDate>/g) || []).length, 2);
  assert.match(body.get('entitlementXML'), /<refId1>Order &amp; 123<\/refId1>/);
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

function serialFile() {
  return { kind: 'product', segments: [{ id: '91', name: 'Serial Number', size: '4', saot: true, value: '' }] };
}

function entitlementApp(fetch, page = 'create-entitlement-form.html', clock) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', page), 'utf8');
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  let definition;
  const location = { target: '', assign(url) { this.target = url; }, search: '' };
  vm.runInNewContext(script, {
    fetch,
    URLSearchParams,
    LeaseDates: require('../public/lease-dates'),
    SerialNumberInput: {},
    Date: clock ? class extends Date {
      constructor(...args) { super(...(args.length ? args : [clock.getTime()])); }
    } : Date,
    window: { location },
    Vue: { createApp: (options) => { definition = options; return { mount() {} }; } },
  });
  const app = { ...definition.methods };
  Object.assign(app, definition.data.call(app));
  app.location = location;
  app.leaseExpiryRange = { minMonths: 6, maxMonths: 24 };
  Object.defineProperty(app, 'memoryProductIds', { get: () => definition.computed.memoryProductIds.call(app) });
  if (definition.computed.filteredCustomers) {
    Object.defineProperty(app, 'filteredCustomers', { get: () => definition.computed.filteredCustomers.call(app) });
  }
  Object.defineProperty(app, 'hasAccessProduct', { get: () => definition.computed.hasAccessProduct.call(app) });
  Object.defineProperty(app, 'leaseProduct', { get: () => definition.computed.leaseProduct.call(app) });
  Object.defineProperty(app, 'otherOptionalProducts', { get: () => definition.computed.otherOptionalProducts.call(app) });
  Object.defineProperty(app, 'leaseSelected', { get: () => definition.computed.leaseSelected.call(app) });
  Object.defineProperty(app, 'leaseBounds', { get: () => definition.computed.leaseBounds.call(app) });
  Object.defineProperty(app, 'selectedVersionId', { get: () => definition.computed.selectedVersionId.call(app) });
  Object.defineProperty(app, 'baseExpirySegment', { get: () => definition.computed.baseExpirySegment.call(app) });
  Object.defineProperty(app, 'baseSerialSegment', { get: () => definition.computed.baseSerialSegment.call(app) });
  Object.defineProperty(app, 'serialMax', { get: () => definition.computed.serialMax.call(app) });
  Object.defineProperty(app, 'serialTooLarge', { get: () => definition.computed.serialTooLarge.call(app) });
  if (definition.computed.serialTooSmall) {
    Object.defineProperty(app, 'serialTooSmall', { get: () => definition.computed.serialTooSmall.call(app) });
  }
  Object.defineProperty(app, 'serialUsed', { get: () => definition.computed.serialUsed.call(app) });
  Object.defineProperty(app, 'productMemoryReady', { get: () => definition.computed.productMemoryReady.call(app) });
  return app;
}

test('creation customer search filters names and clears a hidden selection', () => {
  const app = entitlementApp(async () => {});
  app.customers = [
    { customerId: '1', name: 'Acme North' },
    { customerId: '2', customerName: 'Acme South' },
    { customerId: '3' },
  ];
  assert.equal(app.filteredCustomers.length, 3);
  app.customerSearch = ' AcMe ';
  assert.deepEqual(Array.from(app.filteredCustomers, (customer) => customer.customerId), ['1', '2']);
  app.form.customerId = '2';
  app.filterCustomerSelection();
  assert.equal(app.form.customerId, '2');
  app.customerSearch = 'north';
  app.filterCustomerSelection();
  assert.deepEqual(Array.from(app.filteredCustomers, (customer) => customer.customerId), ['1']);
  assert.equal(app.form.customerId, '');
  app.customerSearch = 'customer 3';
  assert.equal(app.filteredCustomers[0].customerId, '3');
  app.customerSearch = 'absent';
  assert.equal(app.filteredCustomers.length, 0);
  app.customerSearch = '';
  assert.equal(app.filteredCustomers.length, 3);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'create-entitlement-form.html'), 'utf8');
  assert.match(html, /v-model="customerSearch" type="search"/);
  assert.match(html, /id="customer-select"[\s\S]*aria-controls="customer-search-field"[\s\S]*id="customer-search-field" v-show="customerSearchOpen"/);
  assert.match(html, /v-for="customer in filteredCustomers"/);
  assert.match(html, /serialError \|\| !form\.customerId/);
});

test('customer search toggle focuses the input and clears the filter when closed', () => {
  const app = entitlementApp(async () => {});
  let focused = false;
  app.$refs = { customerSearchInput: { focus() { focused = true; } } };
  app.$nextTick = (fn) => fn();
  app.toggleCustomerSearch();
  assert.equal(app.customerSearchOpen, true);
  assert.equal(focused, true);
  app.customerSearch = 'Acme';
  app.toggleCustomerSearch();
  assert.equal(app.customerSearchOpen, false);
  assert.equal(app.customerSearch, '');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(css, /\.customer-search-toggle\[aria-expanded="true"\]/);
});

test('creation form selects the lowest available serial above 06000', async () => {
  let resolve;
  const app = entitlementApp(() => new Promise((done) => { resolve = done; }));
  const pending = app.loadSerialNumber();
  assert.equal(app.serialLoading, true);
  resolve({ ok: true, json: async () => [6001, 6002, 6004] });
  await pending;
  assert.equal(app.serialNumber, '06003');
  assert.deepEqual(Array.from(app.usedSerialNumbers), [6001, 6002, 6004]);
  assert.equal(app.serialLoading, false);
  assert.equal(app.serialError, '');

  app.baseProductId = '60';
  app.productMemory['60'] = { files: [serialFile()] };
  app.serialNumber = '06002';
  assert.equal(app.serialUsed, true);
  app.serialNumber = '06003';
  assert.equal(app.serialUsed, false);

  const first = entitlementApp(async () => ({ ok: true, json: async () => ([]) }));
  await first.loadSerialNumber();
  assert.equal(first.serialNumber, '06001');
  assert.equal(first.encodeSerialNumber(first.serialNumber, '4'), '31373731');

  const failed = entitlementApp(async () => ({ ok: false, json: async () => ({ error: 'EMS unavailable' }) }));
  await failed.loadSerialNumber();
  assert.match(failed.serialError, /EMS unavailable/);
  assert.equal(failed.serialNumber, '');
  const bad = entitlementApp(async () => ({ ok: true, json: async () => ['42'] }));
  await bad.loadSerialNumber();
  assert.match(bad.serialError, /invalid used-serial list/);
  const noGap = entitlementApp(async () => ({
    ok: true, json: async () => Array.from({ length: 65535 - 6001 + 1 }, (_value, index) => index + 6001),
  }));
  await noGap.loadSerialNumber();
  assert.match(noGap.serialError, /No unused serial numbers remain/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'create-entitlement-form.html'), 'utf8');
  assert.match(html, /productError \|\| serialLoading \|\| serialError \|\|/);
  assert.match(html, /serialTooLarge \|\| serialUsed/);
  assert.match(html, /!productMemoryReady \|\| serialTooSmall \|\| serialTooLarge \|\| serialUsed \|\|/);
  assert.match(html, /@click="loadSerialNumber"/);
});

test('update form prevents editing a lease when the entitlement start date is unavailable', async () => {
  let submissions = 0;
  const app = entitlementApp(async (_url, options) => {
    if (options?.method === 'PUT') submissions++;
    return { ok: true, json: async () => ({ customerId: '5', products: [], startDate: 'invalid' }) };
  }, 'update-entitlement-form.html');
  app.editId = '123';
  await app.prefillFromEntitlement();
  assert.equal(app.entitlementLoaded, false);
  assert.match(app.error, /Failed to load entitlement/);
  await app.createEntitlement();
  assert.equal(submissions, 0);
  assert.match(app.error, /Load the entitlement before saving/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'update-entitlement-form.html'), 'utf8');
  assert.match(html, /:disabled="loading \|\| productsLoading \|\| !entitlementLoaded \|\| !leaseProduct\.available/);
  assert.match(html, /:disabled="loading \|\| customersLoading \|\| productsLoading \|\| productError \|\| !entitlementLoaded/);
});

test('update form pads the loaded serial without changing its encoded value', async () => {
  const encoded = '31373733';
  const app = entitlementApp(async (url) => ({
    ok: true,
    json: async () => url.startsWith('/api/entitlements/')
      ? { customerId: '5', refId1: 'ORDER-123', startDate: '2026-11-12', products: [{
        productId: '60', memorySegments: [{ name: 'Serial Number', saot: true, text: encoded }],
      }] }
      : [],
  }), 'update-entitlement-form.html');
  app.editId = '123';
  app.baseProductId = '60';
  await app.prefillFromEntitlement();
  assert.equal(app.entitlementLoaded, true);
  assert.equal(app.form.refId1, 'ORDER-123');
  assert.equal(app.serialNumber, '06003');
  assert.equal(app.encodeSerialNumber(app.serialNumber, '4'), encoded);
  assert.equal(app.decodeSerialNumber('30303030'), '00000');
  assert.equal(app.decodeSerialNumber(''), '');
  assert.equal(app.decodeSerialNumber('invalid'), '');
});

test('update form submits the edited Irricad Order Code', async () => {
  let submitted;
  let requestUrl;
  let requestMethod;
  const app = entitlementApp(async (url, options) => {
    requestUrl = url;
    requestMethod = options.method;
    submitted = JSON.parse(options.body);
    return { ok: true, json: async () => ({}) };
  }, 'update-entitlement-form.html');
  app.editId = '123';
  app.entitlementLoaded = true;
  app.baseProductId = '60';
  app.accessProducts = [{ id: '6048' }];
  app.form.customerId = '5';
  app.form.productIds = ['6048'];
  app.form.refId1 = ' UPDATED-ORDER ';
  app.productMemory['60'] = { loading: false, error: '', files: [serialFile()] };
  app.productMemory['6048'] = { loading: false, error: '', files: [] };
  app.serialNumber = '1234';

  await app.createEntitlement();

  assert.equal(requestUrl, '/api/entitlements/123');
  assert.equal(requestMethod, 'PUT');
  assert.equal(submitted.refId1, 'UPDATED-ORDER');
});

test('update form preserves saved values instead of using product memory defaults', async () => {
  const app = entitlementApp(async (url) => {
    if (url.startsWith('/api/entitlements/')) return {
      ok: true, json: async () => ({
        customerId: '5', startDate: '2026-11-10',
        products: [
          { productId: '60', memorySegments: [{ id: '90', saot: true, text: 'CAFE' }, { id: '91', saot: true, name: 'Serial Number', text: '30303031' }] },
          { productId: '6048', memorySegments: [{ id: '92', saot: true, text: 'BEEF' }] },
        ],
      }),
    };
    return { ok: true, json: async () => [{ kind: 'product', segments: [{ id: '92', saot: true, content: '0000' }] }] };
  }, 'update-entitlement-form.html');
  app.editId = '123';
  app.baseProductId = '60';
  app.accessProducts = [{ id: '6048' }];
  app.productMemory['60'] = { files: [{ kind: 'product', segments: [{ id: '90', saot: true, value: '0000' }] }] };
  await app.prefillFromEntitlement();
  await new Promise(setImmediate);
  assert.equal(app.productMemory['60'].files[0].segments[0].value, 'CAFE');
  assert.equal(app.productMemory['6048'].files[0].segments[0].value, 'BEEF');
});

test('adding and removing products loads their memory without stale responses', async () => {
  const pending = [];
  const app = entitlementApp((url) => new Promise((resolve) => pending.push({ url, resolve })));
  app.optionalProducts = [{ id: '12', label: 'Option', available: true }];
  app.setCheckboxProduct('12', true);
  assert.equal(pending[0].url, '/api/catalog/products/12/read-only-memory');
  assert.equal(app.productMemory['12'].loading, true);
  app.setCheckboxProduct('12', false);
  app.setCheckboxProduct('12', true);
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

test('creation form has no additional product picker and retains product error retry', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'create-entitlement-form.html'), 'utf8');
  assert.doesNotMatch(html, /product-picker|productToAdd|Additional modification products/);
  assert.match(html, /v-if="productError"[\s\S]*?@click="loadProducts"/);
  assert.doesNotMatch(html, /Read-only memory segments|displayedMemoryProductIds/);
  assert.match(html, /@click="loadProductMemory\(productId\)"/);
});

test('loads modification products and required base memory for creation', async () => {
  const requests = [];
  const app = entitlementApp(async (url) => {
    requests.push(url);
    return { ok: true, json: async () => url === '/api/entitlement-products'
      ? { baseProductId: '60', leaseExpiryRange: { minMonths: 6, maxMonths: 24 }, modifications: [
        { productId: '12', productName: 'Update' },
        { productId: '6048', productName: 'Standalone' },
        { productId: '6049', productName: 'Link' },
        { productId: '6051', productName: 'Pivot' },
        { productId: '6050', productName: 'Lease' },
        { productId: '6052', productName: 'Version 23' },
      ], accessProducts: [{ id: '6048', label: 'Standalone' }, { id: '6049', label: 'Link' }],
      optionalProducts: [{ id: '6051', label: 'Pivot', available: true }, { id: '6050', label: 'Lease', lease: true, available: true }],
      versionProducts: [{ id: '6052', label: 'Version 23', available: true }] }
      : [{ kind: 'product', segments: [
        { id: '90', saot: true, content: '0000' },
        { id: '91', name: 'Serial Number', size: '4', saot: true, content: '0000' },
      ] }] };
  });
  await app.loadProducts();
  assert.deepEqual(requests, ['/api/entitlement-products', '/api/catalog/products/60/read-only-memory']);
  assert.equal(app.baseProductId, '60');
  assert.equal(app.products[0].productId, '12');
  assert.equal(app.productMemoryReady, true);
  assert.equal(app.productMemory['60'].files[0].segments[0].value, '0000');
});

test('version radios select one modification and leave as is removes it', async () => {
  const requests = [];
  const app = entitlementApp(async (url) => {
    requests.push(url);
    return { ok: true, json: async () => [{ kind: 'product', segments: [{ id: '4', saot: true, content: '0000' }] }] };
  });
  app.baseProductId = '60';
  app.productMemory['60'] = { loading: false, error: '', files: [serialFile()] };
  app.versionProducts = [{ id: '6052', label: 'Version 23', available: true }];
  app.products = [{ productId: '6052' }, { productId: '12' }];
  assert.equal(app.selectedVersionId, '');
  app.setVersionProduct('6052');
  assert.equal(app.selectedVersionId, '6052');
  assert.equal(app.productMemoryReady, false);
  await new Promise(setImmediate);
  assert.equal(requests[0], '/api/catalog/products/6052/read-only-memory');
  assert.equal(app.productMemoryReady, true);
  assert.equal(app.productMemory['6052'].files[0].segments[0].value, '0000');
  app.setVersionProduct('');
  assert.equal(app.selectedVersionId, '');
  assert.equal(app.productMemory['6052'], undefined);
  app.versionProducts[0].available = false;
  app.setVersionProduct('6052');
  assert.equal(app.selectedVersionId, '');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'create-entitlement-form.html'), 'utf8');
  assert.match(html, /<legend>Versions<\/legend>\s*<p class="form-hint">Up to and including<\/p>[\s\S]*?type="radio" name="version"[\s\S]*?\{\{ defaultVersionLabel \}\} \(default\)[\s\S]*?v-for="product in versionProducts"[\s\S]*?type="radio" name="version"/);
});

test('lease checkbox controls the base expiry value and loads lease memory', async () => {
  const app = entitlementApp(async (url) => ({ ok: true, json: async () =>
    url.includes('/60/') ? [{ kind: 'product', segments: [
      { id: '90', name: 'Expiry Date', size: '4', saot: true, content: '00000000' },
      { id: '91', name: 'Serial Number', size: '4', saot: true, content: '00000000' },
    ] }] : [] }));
  app.baseProductId = '60';
  await app.loadProductMemory('60');
  const file = app.productMemory['60'].files[0];
  const segment = file.segments[0];
  assert.equal(segment.value, '');
  assert.equal(file.segments[1].value, '');
  app.optionalProducts = [
    { id: '6051', label: 'Pivot', available: true },
    { id: '6050', label: 'Lease', lease: true, available: true },
  ];
  assert.equal(app.leaseProduct.id, '6050');
  assert.deepEqual(Array.from(app.otherOptionalProducts, (product) => product.id), ['6051']);
  app.products = [{ productId: '6050', productName: 'Lease' }];
  assert.equal(app.leaseSelected, false);
  assert.equal(app.isBaseExpirySegment('60', file, segment), true);
  assert.equal(app.isBaseExpirySegment('60', file, file.segments[1]), false);
  assert.equal(app.isBaseSerialSegment('60', file, file.segments[1]), true);
  app.setCheckboxProduct('6050', true);
  await new Promise(setImmediate);
  assert.equal(app.leaseSelected, true);
  assert.equal(app.leaseExpiryDate, app.defaultLeaseExpiryDate());
  app.leaseExpiryDate = '2030-07-12';
  assert.equal(app.baseExpirySegment, segment);
  assert.equal(app.productMemoryReady, true);
  segment.size = '2';
  assert.equal(app.productMemoryReady, false);
  segment.size = '4';
  app.setCheckboxProduct('6050', false);
  assert.equal(app.leaseSelected, false);
  assert.equal(app.productMemory['6050'], undefined);
  app.setCheckboxProduct('6050', true);
  assert.equal(app.leaseExpiryDate, '2030-07-12');
  await new Promise(setImmediate);
});

test('default lease expiry is one calendar year from the UTC start date', () => {
  const app = entitlementApp(async () => {});
  assert.equal(app.defaultLeaseExpiryDate(new Date('2026-11-12T12:00:00Z')), '2027-11-12');
  assert.equal(app.defaultLeaseExpiryDate(new Date('2024-02-29T12:00:00Z')), '2025-02-28');
  assert.equal(app.defaultLeaseExpiryDate(new Date('2027-12-31T12:00:00Z')), '2028-12-31');
});

test('creation uses the UTC date across local midnight and bases lease bounds on it', async () => {
  const originalTimezone = process.env.TZ;
  try {
    for (const [timezone, instant, utcDate, localDate, minimum, maximum, expiry] of [
      ['Pacific/Auckland', '2026-11-11T11:30:00Z', '2026-11-11', '2026-11-12', '2027-05-11', '2027-12-11', '2027-11-11'],
      ['America/Los_Angeles', '2026-11-12T00:30:00Z', '2026-11-12', '2026-11-11', '2027-05-12', '2027-12-12', '2027-11-12'],
    ]) {
      process.env.TZ = timezone;
      const clock = new Date(instant);
      let submitted;
      const app = entitlementApp(async (_url, options) => {
        submitted = JSON.parse(options.body);
        return { ok: true, json: async () => ({}) };
      }, 'create-entitlement-form.html', clock);
      app.leaseExpiryRange = { minMonths: 6, maxMonths: 13 };
      assert.equal(app.localToday(clock), localDate);
      assert.equal(app.utcToday(clock), utcDate);
      assert.equal(app.leaseBounds.min, minimum);
      assert.equal(app.leaseBounds.max, maximum);
      assert.equal(app.defaultLeaseExpiryDate(clock), expiry);
      app.baseProductId = '60';
      app.form.productIds = ['6050'];
      app.form.refId1 = 'ORDER';
      app.optionalProducts = [{ id: '6050', lease: true, available: true }];
      app.productMemory['60'] = { files: [{ kind: 'product', segments: [
        { id: '90', name: 'Expiry Date', size: '4', saot: true },
        { id: '91', name: 'Serial Number', size: '4', saot: true },
      ] }] };
      app.productMemory['6050'] = { files: [] };
      app.leaseExpiryDate = expiry;
      app.serialNumber = '1';
      await app.createEntitlement();
      assert.equal(submitted.startDate, utcDate);
    }
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});

test('hidden base expiry input is removed from form validation', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'create-entitlement-form.html'), 'utf8');
  assert.match(html, /<legend>Optional products<\/legend>[\s\S]*?v-for="product in otherOptionalProducts"[\s\S]*?<\/fieldset>\s*<fieldset class="access-products">\s*<legend>Lease<\/legend>[\s\S]*?v-if="leaseProduct"[\s\S]*?<div v-if="leaseSelected" class="lease-options">/);
  assert.match(html, /<div v-if="leaseSelected" class="lease-options">/);
  assert.match(html, /Lease Expiry Date \(Local time\)/);
  assert.match(html, /v-model="leaseExpiryDate" type="date" :min="leaseBounds\.min" :max="leaseBounds\.max" required/);
  assert.doesNotMatch(html, /<tr v-if="!isBaseExpirySegment/);
  assert.doesNotMatch(html, /v-show="!isBaseExpirySegment/);
});

test('lease dates encode four ASCII hexadecimal digits and reject invalid dates', () => {
  const app = entitlementApp(async () => {});
  assert.equal(app.encodeLeaseExpiryDate('2026-11-10'), '35443641');
  assert.equal(app.encodeLeaseExpiryDate('1980-01-01'), '30303231');
  assert.equal(app.encodeLeaseExpiryDate('2107-12-31'), '46463946');
  assert.equal(app.encodeLeaseExpiryDate('2000-02-29'), '32383544');
  for (const date of ['', '1979-12-31', '2108-01-01', '2025-02-29', '2026-13-01', '2026-00-01', '2026-11-00']) {
    assert.throws(() => app.encodeLeaseExpiryDate(date), /valid lease expiry date/);
  }
});

test('lease creation submits the encoded date and retains other SAOT values', async () => {
  let submitted;
  const app = entitlementApp(async (_url, options) => {
    submitted = JSON.parse(options.body);
    return { ok: true, json: async () => ({}) };
  });
  app.loadEntitlements = async () => {};
  app.baseProductId = '60';
  app.optionalProducts = [{ id: '6050', label: 'Lease', lease: true, available: true }];
  app.form.productIds = ['6050'];
  app.productMemory['60'] = { loading: false, error: '', files: [{ kind: 'product', segments: [
    { id: '90', name: 'Expiry Date', size: '4', saot: true, value: '' },
    { id: '91', name: 'Serial Number', size: '4', saot: true, value: '' },
  ] }] };
  app.productMemory['6050'] = { loading: false, error: '', files: [] };
  app.leaseExpiryDate = '2026-11-10';
  app.localToday = () => '2026-05-10';
  app.utcToday = () => '2026-05-10';
  app.serialNumber = '1234';
  app.form.refId1 = 'ORDER';
  await app.createEntitlement();
  assert.deepEqual(JSON.parse(JSON.stringify(submitted.memoryValues)), [
    { productId: '60', segmentId: '90', content: '35443641' },
    { productId: '60', segmentId: '91', content: '30344432' },
  ]);
  assert.equal(app.leaseExpiryDate, '');
  assert.equal(app.serialNumber, '');
});

test('serial input flags out-of-range values on both forms', () => {
  for (const page of ['create-entitlement-form.html', 'update-entitlement-form.html']) {
    const app = entitlementApp(async () => {}, page);
    app.baseProductId = '60';
    app.productMemory['60'] = { loading: false, error: '', files: [serialFile()] };
    for (const [value, tooLarge] of [['65535', false], ['65536', true], ['999999', true], ['00065535', false], ['', false]]) {
      app.serialNumber = value;
      assert.equal(app.serialTooLarge, tooLarge);
    }
    if (page === 'create-entitlement-form.html') {
      for (const [value, tooSmall] of [['05999', true], ['06000', false], ['06001', false], ['', false]]) {
        app.serialNumber = value;
        assert.equal(app.serialTooSmall, tooSmall);
      }
    }
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', page), 'utf8');
    assert.match(html, /v-(?:if|else-if)="serialTooLarge" id="serial-error" class="form-error" role="alert"/);
    if (page === 'create-entitlement-form.html') {
      assert.match(html, /!productMemoryReady \|\| serialTooSmall \|\| serialTooLarge \|\|/);
    } else {
      assert.match(html, /!productMemoryReady \|\| serialTooLarge \|\|/);
    }
    assert.match(html, /<serial-number-input v-if="baseSerialSegment" v-model="serialNumber"/);
    assert.match(html, /src="\/serial-number-input\.js"/);
  }
});

test('serial numbers convert from decimal to ASCII hexadecimal digits', () => {
  const app = entitlementApp(async () => {});
  assert.equal(app.encodeSerialNumber('255', '4'), '30304646');
  assert.equal(app.encodeSerialNumber('0', '2'), '3030');
  for (const value of ['', '12a', '-1', '65536']) {
    assert.throws(() => app.encodeSerialNumber(value, '4'), /serial number/i);
  }
  assert.throws(() => app.encodeSerialNumber('65536', '4'), /65,535 or less/);
});

test('out-of-range serial numbers are not submitted by either form', async () => {
  for (const page of ['create-entitlement-form.html', 'update-entitlement-form.html']) {
    let requests = 0;
    const app = entitlementApp(async () => { requests++; }, page);
    app.baseProductId = '60';
    app.productMemory['60'] = { loading: false, error: '', files: [serialFile()] };
    app.entitlementLoaded = true;
    app.serialNumber = '65536';
    app.form.refId1 = 'ORDER';
    await app.createEntitlement();
    assert.equal(requests, 0);
    assert.match(app.error, /65,535 or less/);
  }
});

test('creation form rejects empty or whitespace-only order codes', async () => {
  let requests = 0;
  const app = entitlementApp(async () => { requests++; });
  for (const value of ['', '   ']) {
    app.form.refId1 = value;
    await app.createEntitlement();
    assert.match(app.error, /Order Code/);
  }
  assert.equal(requests, 0);
});

test('invalid lease date prevents submission', async () => {
  let requests = 0;
  const app = entitlementApp(async () => { requests++; });
  app.optionalProducts = [{ id: '6050', label: 'Lease', lease: true, available: true }];
  app.form.productIds = ['6050'];
  app.leaseExpiryDate = '2025-02-29';
  app.form.refId1 = 'ORDER';
  await app.createEntitlement();
  assert.equal(requests, 0);
  assert.match(app.error, /lease expiry date|Invalid calendar date/i);
});

test('access checkboxes allow either or both', async () => {
  const app = entitlementApp(async () => ({ ok: true, json: async () => [] }));
  app.baseProductId = '60';
  app.productMemory['60'] = { loading: false, error: '', files: [] };
  app.accessProducts = [{ id: '6048', label: 'Standalone' }, { id: '6049', label: 'Link' }];
  app.products = [{ productId: '6048' }, { productId: '6049' }, { productId: '12' }];
  assert.equal(app.hasAccessProduct, false);
  app.setCheckboxProduct('6048', true);
  await new Promise(setImmediate);
  assert.equal(app.hasAccessProduct, true);
  assert.deepEqual(Array.from(app.memoryProductIds), ['60', '6048']);
  app.setCheckboxProduct('6049', true);
  await new Promise(setImmediate);
  app.setCheckboxProduct('6048', false);
  assert.equal(app.hasAccessProduct, true);
  app.setCheckboxProduct('6049', false);
  assert.equal(app.hasAccessProduct, false);
});

test('Pivot is optional and loads and removes memory', async () => {
  const requests = [];
  const app = entitlementApp(async (url) => {
    requests.push(url);
    return { ok: true, json: async () => [{ kind: 'product', segments: [{ id: '90', saot: true, content: '0000' }] }] };
  });
  app.baseProductId = '60';
  app.productMemory['60'] = { loading: false, error: '', files: [serialFile()] };
  app.accessProducts = [{ id: '6048', label: 'Standalone' }];
  app.optionalProducts = [{ id: '6051', label: 'Pivot', available: true }];
  app.products = [{ productId: '6048' }, { productId: '6051' }, { productId: '12' }];
  app.setCheckboxProduct('6051', true);
  assert.equal(app.hasAccessProduct, false);
  assert.equal(app.productMemoryReady, false);
  await new Promise(setImmediate);
  assert.equal(requests[0], '/api/catalog/products/6051/read-only-memory');
  assert.equal(app.productMemoryReady, true);
  assert.equal(app.productMemory['6051'].files[0].segments[0].value, '0000');
  assert.ok(app.memoryProductIds.includes('6051'));
  app.setCheckboxProduct('6051', false);
  assert.equal(app.form.productIds.length, 0);
  assert.equal(app.productMemory['6051'], undefined);
});

test('form blocks saving while memory is unavailable or dynamic SAOT is unsupported', async () => {
  const app = entitlementApp(async () => ({
    ok: true, json: async () => [{ kind: 'dynamic', segments: [{ saot: true }] }],
  }));
  app.form.productIds = ['12'];
  app.baseProductId = '60';
  app.productMemory['60'] = { loading: false, error: '', files: [serialFile()] };
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
    return {
      ok: true,
      json: async () => ({ serialNumberUpdated: false, serialNumberError: 'counter update failed & needs review' }),
    };
  });

  app.loadEntitlements = async () => {};
  app.form.productIds = ['12'];
  app.baseProductId = '60';
  app.productMemory['60'] = { loading: false, error: '', files: [
    { kind: 'product', segments: [{ id: '3', saot: true, value: '00AA' }, serialFile().segments[0]] },
  ] };
  app.productMemory['12'] = { loading: false, error: '', files: [
    { kind: 'product', segments: [
      { id: '1', saot: true, value: '00FF' },
      { id: '2', saot: false, content: 'AA' },
    ] },
  ] };
  assert.equal(app.productMemoryReady, true);
  app.serialNumber = '10';
  app.form.refId1 = ' ORDER-123 ';
  app.form.description = ' Description ';
  app.utcToday = () => '2026-11-12';
  await app.createEntitlement();
  assert.equal(app.location.target,
    '/entitlements.html?created=1&serialWarning=counter%20update%20failed%20%26%20needs%20review');
  assert.equal(submitted.refId1, 'ORDER-123');
  assert.equal(submitted.description, 'Description');
  assert.equal(Object.hasOwn(submitted, 'enforcementId'), false);
  assert.equal(Object.hasOwn(submitted, 'lineItemType'), false);
  assert.equal(submitted.startDate, '2026-11-12');
  assert.equal(Object.hasOwn(submitted, 'neverExpires'), false);
  assert.equal(Object.hasOwn(submitted, 'endDate'), false);
  assert.equal(Object.hasOwn(submitted, 'numberOfKeys'), false);
  assert.equal(Object.hasOwn(submitted, 'activationsPerKey'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(submitted.memoryValues)), [
    { productId: '60', segmentId: '3', content: '00AA' },
    { productId: '60', segmentId: '91', content: '30303041' },
    { productId: '12', segmentId: '1', content: '00FF' },
  ]);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'create-entitlement-form.html'), 'utf8');
  assert.match(html, /Irricad Order Code \(refID 1\) \* <span id="ref-id-remaining" class="form-hint character-count">- \{\{ 250 - form\.refId1\.length \}\} chars left<\/span><\/span>\s*<input v-model="form\.refId1" type="text" maxlength="250" required pattern=".*\\S.*"/);
  const updateHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'update-entitlement-form.html'), 'utf8');
  assert.match(updateHtml, /Irricad Order Code \(refID 1\) <span id="ref-id-remaining" class="form-hint character-count">- \{\{ 250 - form\.refId1\.length \}\} chars left<\/span><\/span>\s*<input v-model="form\.refId1" type="text" maxlength="250"/);
  for (const page of ['create-entitlement-form.html', 'update-entitlement-form.html']) {
    const formHtml = fs.readFileSync(path.join(__dirname, '..', 'public', page), 'utf8');
    assert.match(formHtml, /<textarea v-model="form\.description" maxlength="510" rows="3" aria-describedby="description-remaining"/);
    assert.match(formHtml, /<span>Description <span id="description-remaining" class="form-hint character-count">- \{\{ 510 - form\.description\.length \}\} chars left<\/span><\/span>/);
  }
});

test('entitlements list links to the separate create form page', () => {
  const dir = path.join(__dirname, '..', 'public');
  const list = fs.readFileSync(path.join(dir, 'entitlements.html'), 'utf8');
  const script = list.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  let definition;
  let target;
  vm.runInNewContext(script, {
    fetch: async () => ({ ok: true, json: async () => [] }),
    window: { location: { assign: (url) => { target = url; }, search: '' } },
    URLSearchParams,
    Vue: { createApp: (options) => { definition = options; return { mount() {} }; } },
  });
  definition.methods.openCreateEntitlement();
  assert.equal(target, '/create-entitlement-form.html');
  assert.doesNotMatch(list, /class="entitlement-form"|<legend>/);
  assert.ok(fs.existsSync(path.join(dir, 'create-entitlement-form.html')));
});

test('shared head, disclaimer and nav are included into pages with the right current link', () => {
  const { renderPage } = require('../page-includes');
  const dir = path.join(__dirname, '..');
  const render = (file, route) => renderPage(fs.readFileSync(path.join(dir, 'public', file), 'utf8'), path.join(dir, 'partials'), route);
  const entitlements = render('entitlements.html', '/entitlements.html');
  assert.doesNotMatch(entitlements, /<!-- include:/);
  assert.match(entitlements, /<link rel="stylesheet" href="\/styles.css">\s*<script src="\/theme.js"><\/script>/);
  assert.match(entitlements, /class="dev-disclaimer">Development in progress/);
  assert.match(entitlements, /<a href="\/entitlements.html" aria-current="page">Entitlements<\/a>\s*<a href="\/activations.html">Activations<\/a>\s*<a href="\/">Customers<\/a>/);
  const activations = render('activations.html', '/activations.html');
  assert.match(activations, /<a href="\/activations.html" aria-current="page">Activations<\/a>/);
  assert.match(activations, /All activations/);
  assert.match(render('index.html', '/'), /<a href="\/entitlements.html">Entitlements<\/a>\s*<a href="\/activations.html">Activations<\/a>\s*<a href="\/" aria-current="page">Customers<\/a>/);
});

test('deletes an entitlement with DELETE on the numeric entitlement ws path', async () => {
  const client = new EmsClient({ baseUrl: 'https://ems.example' });
  client.authenticated = true;
  const calls = [];
  client._fetch = async (url, options) => {
    calls.push({ url, method: options.method });
    return { ok: true, status: 200, statusText: 'OK', text: async () => '' };
  };
  assert.deepEqual(await client.deleteEntitlement('5057'), { deleted: true, entId: '5057' });
  assert.deepEqual(calls, [{ url: 'https://ems.example/ems/v90/ws/entitlement/5057.ws', method: 'DELETE' }]);
  await assert.rejects(() => client.deleteEntitlement('abc'), /positive number/);
});
