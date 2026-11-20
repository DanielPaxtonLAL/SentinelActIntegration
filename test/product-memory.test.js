const test = require('node:test');
const assert = require('node:assert/strict');
const { EmsClient } = require('../src/ems-client');
const { validateMemoryValues } = require('../src/entitlement-memory');

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
