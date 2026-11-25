const test = require('node:test');
const assert = require('node:assert/strict');
const { EmsClient } = require('../src/ems-client');

const responseXml = `<productKey><productKeyId>key-001</productKeyId><totalEntitled>1</totalEntitled>
<available>0</available><enabled>true</enabled><type>Product Key-based</type>
<productInfo id="001" productName="Base" productIdentifier="02" type="BASE"/>
<activationAttribute><attributeName>C2V</attributeName><attributeValue>null</attributeValue>
<isvPermission>NONE</isvPermission><endUserPermission>WRITE</endUserPermission></activationAttribute>
<activationInfo><activationId>activation-001</activationId></activationInfo>
<entitlementId>123</entitlementId><customerId>5</customerId></productKey>`;

function createClient() {
  const client = new EmsClient({ baseUrl: 'https://ems.example' });
  client.getEntitlementDetails = async () => ({
    entState: 'PRODUCT_KEY_GENERATED',
    entitlementItem: { lineItemType: 'Product_Key', productKeyId: 'key-001' },
  });
  client._fetch = async () => ({ ok: true, text: async () => responseXml });
  return client;
}

test('loads product key details including product attributes and activation permissions', async () => {
  const client = createClient();
  let url;
  client._fetch = async (path) => { url = path; return { ok: true, text: async () => responseXml }; };
  const [key] = await client.getEntitlementProductKeys('123');
  assert.equal(url, 'https://ems.example/ems/v90/ws/productKey/key-001.ws');
  assert.equal(key.productKeyId, 'key-001');
  assert.equal(key.available, '0');
  assert.equal(key.productInfo[0].id, '001');
  assert.equal(key.productInfo[0].productIdentifier, '02');
  assert.equal(key.activationAttribute[0].endUserPermission, 'WRITE');
  assert.deepEqual(key.activationIds, ['activation-001']);
});

test('reads product-key AIDs with protection key attributes and multiple activations', async () => {
  const client = createClient();
  const aids = '<AID protectionKeyId="712734935">activation-001</AID>' +
    '<AID protectionKeyId="712734936">activation-002</AID>' +
    '<AID>activation-001</AID>';
  client._fetch = async () => ({
    ok: true,
    text: async () => responseXml.replace('<activationInfo><activationId>activation-001</activationId></activationInfo>', aids),
  });
  const [key] = await client.getEntitlementProductKeys('123');
  assert.deepEqual(key.activationIds, ['activation-001', 'activation-002']);
  assert.deepEqual(key.activationReferences, [
    { aid: 'activation-001', protectionKeyId: '712734935' },
    { aid: 'activation-002', protectionKeyId: '712734936' },
    { aid: 'activation-001', protectionKeyId: null },
  ]);
});

test('handles multiple keys and rejects missing IDs or non-generated entitlements', async () => {
  const client = createClient();
  client.getEntitlementDetails = async () => ({ entState: 'PRODUCT_KEY_GENERATED', entitlementItem: [
    { lineItemType: 'Product_Key', productKeyId: ['key-001', 'key-002'] },
    { lineItemType: 'Product_Key', productKeyId: 'key-001' },
  ] });
  client._fetch = async (url) => ({ ok: true, text: async () => url.includes('key-002') ? responseXml.replace('key-001', 'key-002') : responseXml });
  assert.equal((await client.getEntitlementProductKeys('123')).length, 2);
  client.getEntitlementDetails = async () => ({ entState: 'DRAFT' });
  await assert.rejects(() => client.getEntitlementProductKeys('123'), /only available/);
  client.getEntitlementDetails = async () => ({ entState: 'PRODUCT_KEY_GENERATED', entitlementItem: { lineItemType: 'Product_Key' } });
  await assert.rejects(() => client.getEntitlementProductKeys('123'), /product key ID/);
});

test('loads completed entitlement product and update keys and rejects missing key IDs', async () => {
  const client = createClient();
  client.getEntitlementDetails = async () => ({ entState: 'COMPLETED', entitlementItem: [
    { lineItemType: 'Product_Key', productKeyId: 'key-001' },
    { lineItemType: 'ProtectionKey_Update', productKeyId: 'key-002' },
  ] });
  client._fetch = async (url) => ({
    ok: true,
    text: async () => url.includes('key-002') ? responseXml.replace('key-001', 'key-002') : responseXml,
  });
  assert.deepEqual((await client.getEntitlementProductKeys('123')).map((key) => key.productKeyId), ['key-001', 'key-002']);
  client.getEntitlementDetails = async () => ({ entState: 'COMPLETED', entitlementItem: { lineItemType: 'ProtectionKey_Update' } });
  await assert.rejects(() => client.getEntitlementProductKeys('123'), /product key ID/);
});

test('discovers existing product keys across entitlement states without changing the generated-key API', async () => {
  const client = createClient();
  client.getEntitlementDetails = async (id, options) => {
    assert.equal(id, '123');
    assert.equal(options.includeCustomer, false);
    return { entState: 'COMPLETED', entitlementItem: [
      { lineItemType: 'Hardware_Key' },
      { lineItemType: 'Product_Key', productKeyId: 'key-001' },
      { lineItemType: 'Product_Key' },
    ] };
  };
  client._fetch = async () => ({
    ok: true,
    text: async () => responseXml.replace('<activationInfo><activationId>activation-001</activationId></activationInfo>',
      '<activationInfo AID="activation-002"><activationId>activation-001</activationId></activationInfo>'),
  });
  const [key] = await client.getProductKeysForActivations('123');
  assert.deepEqual(key.activationIds, ['activation-001', 'activation-002']);
  client.getEntitlementDetails = async () => ({ entState: 'DRAFT', entitlementItem: { lineItemType: 'Product_Key' } });
  assert.deepEqual(await client.getProductKeysForActivations('123'), []);
});

test('discovers update product keys for history and reports missing update keys', async () => {
  const client = createClient();
  client.getEntitlementDetails = async () => ({ entitlementItem: [
    { lineItemType: 'Product_Key', productKeyId: 'key-001' },
    { lineItemType: 'ProtectionKey_Update', productKeyId: 'key-002' },
    { lineItemType: 'ProtectionKey_Update' },
    { lineItemType: 'Hardware_Key', productKeyId: 'other' },
  ] });
  client._fetch = async (url) => ({
    ok: true,
    text: async () => url.includes('key-002') ? responseXml.replace('key-001', 'key-002') : responseXml,
  });
  const result = await client.getProtectionKeyActivationCandidates('123');
  assert.deepEqual(result.keys.map((key) => key.productKeyId), ['key-001', 'key-002']);
  assert.equal(result.missingUpdateProductKey, true);
  assert.deepEqual((await client.getProductKeysForActivations('123')).map((key) => key.productKeyId), ['key-001']);
});

test('reads associated protection key entitlements and rejects incomplete results', async () => {
  const client = createClient();
  let xml = '<entitlementListResponse count="2"><entitlementInstance entId="123"/><entitlementInstance entId="456"/></entitlementListResponse>';
  client._fetch = async (url) => {
    assert.equal(url, 'https://ems.example/ems/v90/ws/target/12345/entitlement.ws');
    return { ok: true, text: async () => xml };
  };
  assert.deepEqual(await client.getProtectionKeyEntitlements('12345'), ['123', '456']);
  xml = '<listResponse type="entitlement" count="2"><instance id="123"/><instance id="456"/></listResponse>';
  assert.deepEqual(await client.getProtectionKeyEntitlements('12345'), ['123', '456']);
  client._fetch = async () => ({ ok: true, headers: { get: () => '1' }, text: async () => xml });
  xml = '<listResponse type="entitlement"><instance id="123"/></listResponse>';
  assert.deepEqual(await client.getProtectionKeyEntitlements('12345'), ['123']);
  xml = '<listResponse type="entitlement" count="2"><instance id="123"/><instance id="456"/></listResponse>';
  await assert.rejects(() => client.getProtectionKeyEntitlements('12345'), /incomplete/);
  client._fetch = async () => ({ ok: true, text: async () => xml });
  xml = '<entitlementListResponse count="0"/>';
  assert.deepEqual(await client.getProtectionKeyEntitlements('12345'), []);
  xml = '<entitlementListResponse count="2"><entitlementInstance entId="123"/></entitlementListResponse>';
  await assert.rejects(() => client.getProtectionKeyEntitlements('12345'), /incomplete/);
  xml = '<entitlementListResponse count="2"><entitlementInstance entId="123"/><entitlementInstance entId="123"/></entitlementListResponse>';
  await assert.rejects(() => client.getProtectionKeyEntitlements('12345'), /invalid/);
  xml = '<listResponse><instance customer="private customer" id="123"/></listResponse>';
  await assert.rejects(() => client.getProtectionKeyEntitlements('12345'), (err) => {
    assert.match(err.message, /root: listResponse; count: missing; recognized fields: instance/);
    assert.doesNotMatch(err.message, /private customer|123/);
    return true;
  });
  xml = '<entitlementListResponse><entitlementInstance entId="123"/></entitlementListResponse>';
  await assert.rejects(() => client.getProtectionKeyEntitlements('12345'), /count: missing; recognized fields: entitlementInstance/);
});

test('reads an activation history counter and rejects a different protection key', async () => {
  const client = createClient();
  let xml = '<sentinel_ldk_info><key><id>12345</id><update_counter>32</update_counter></key></sentinel_ldk_info>';
  client._fetch = async (url) => {
    assert.equal(url, 'https://ems.example/ems/v90/ws/target/12345/activation.ws?AID=aid%2F1');
    return { ok: true, text: async () => xml };
  };
  assert.equal(await client.getActivationUpdateCounter('12345', 'aid/1'), '32');
  const history = '<sentinel_ldk_info><key><id>12345</id><update_counter>33</update_counter></key></sentinel_ldk_info>';
  xml = `<ProtectionKey><ProtectionKeyOutput><C2V>${history}</C2V></ProtectionKeyOutput></ProtectionKey>`;
  assert.equal(await client.getActivationUpdateCounter('12345', 'aid/1'), '33');
  xml = `<ProtectionKey><ProtectionKeyOutput><UpdateInfo>${history}</UpdateInfo></ProtectionKeyOutput></ProtectionKey>`;
  assert.equal(await client.getActivationUpdateCounter('12345', 'aid/1'), '33');
  const escaped = history.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  xml = `<ProtectionKey><ProtectionKeyOutput><UpdateInfo>${escaped}</UpdateInfo></ProtectionKeyOutput></ProtectionKey>`;
  assert.equal(await client.getActivationUpdateCounter('12345', 'aid/1'), '33');
  xml = '<sentinel_ldk_info><key><id>12345</id><update_counter>32</update_counter></key></sentinel_ldk_info>';
  xml = xml.replace('<id>12345</id>', '<id>54321</id>');
  await assert.rejects(() => client.getActivationUpdateCounter('12345', 'aid/1'), (err) => {
    assert.match(err.message, /root: sentinel_ldk_info; UpdateInfo: missing; key: present; key ID: different or non-text; update counter: numeric/);
    assert.doesNotMatch(err.message, /12345|54321|32/);
    return true;
  });
  xml = '<sentinel_ldk_info><key><id>12345</id></key></sentinel_ldk_info>';
  await assert.rejects(() => client.getActivationUpdateCounter('12345', 'aid/1'), /key ID: matches; update counter: missing/);
  xml = '<ProtectionKey><ProtectionKeyOutput><secret>private</secret></ProtectionKeyOutput></ProtectionKey>';
  await assert.rejects(() => client.getActivationUpdateCounter('12345', 'aid/1'), (err) => {
    assert.match(err.message, /root: ProtectionKey; UpdateInfo: missing; key: missing/);
    assert.doesNotMatch(err.message, /private/);
    return true;
  });
});

test('paginates entitlement discovery and rejects incomplete or changing results', async () => {
  const client = createClient();
  client.authenticated = true;
  const paths = [];
  let pages = [
    { count: '2', xml: '<listResponse><instance id="1" customer="A"/></listResponse>' },
    { count: '2', xml: '<listResponse><instance id="2" customer="B"/></listResponse>' },
  ];
  client._fetch = async (url) => {
    paths.push(url);
    const page = pages[paths.length - 1];
    return { ok: true, headers: { get: () => page.count }, text: async () => page.xml };
  };
  const entitlements = await client.listEntitlementsForActivations();
  assert.deepEqual(entitlements.map((entry) => entry.id), ['1', '2']);
  assert.match(paths[1], /pageIndex=2&pageSize=100$/);
  paths.length = 0;
  pages = [{ count: null, xml: '<listResponse/>' }];
  await assert.rejects(() => client.listEntitlementsForActivations(), /count/);
  paths.length = 0;
  pages = [
    { count: '2', xml: '<listResponse><instance id="1"/></listResponse>' },
    { count: '2', xml: '<listResponse/>' },
  ];
  await assert.rejects(() => client.listEntitlementsForActivations(), /incomplete/);
  paths.length = 0;
  pages[1] = { count: '3', xml: '<listResponse><instance id="2"/></listResponse>' };
  await assert.rejects(() => client.listEntitlementsForActivations(), /changed/);
});

test('reports failed or mismatched EMS key lookups', async () => {
  const client = createClient();
  client._fetch = async () => ({ ok: false, status: 404, statusText: 'Not Found', text: async () => '' });
  await assert.rejects(() => client.getEntitlementProductKeys('123'), /404/);
  client._fetch = async () => ({ ok: true, text: async () => '<invalid' });
  await assert.rejects(() => client.getEntitlementProductKeys('123'), /invalid product key XML/);
  client._fetch = async () => ({ ok: true, text: async () => responseXml.replace('<entitlementId>123', '<entitlementId>124') });
  await assert.rejects(() => client.getEntitlementProductKeys('123'), /unexpected key or entitlement/);
});

test('loads a license by Activation ID and verifies the returned ID', async () => {
  const client = createClient();
  const activationXml = `<activation><activationOutput><AID>activation-001</AID>
  <protectionKeyId>712734935</protectionKeyId><activationString>license-data</activationString>
  </activationOutput></activation>`;
  let url;
  client._fetch = async (path) => {
    url = path;
    return { ok: true, text: async () => activationXml };
  };
  assert.deepEqual(await client.getActivationLicense('activation-001'), {
    aid: 'activation-001',
    protectionKeyId: '712734935',
    activationString: 'license-data',
  });
  assert.equal(url, 'https://ems.example/ems/v90/ws/activation/activation-001.ws');

  client._fetch = async () => ({
    ok: true,
    text: async () => activationXml.replace('activation-001', 'unexpected'),
  });
  await assert.rejects(() => client.getActivationLicense('activation-001'), /unexpected Activation ID/);
});

test('reads the C2V saved in an activation record as text or nested XML', async () => {
  const client = createClient();
  const c2v = '<?xml version="1.0"?><hasp_info><haspscope><hasp id="123"/></haspscope><c2v>YWJj</c2v></hasp_info>';
  const encoded = c2v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let url;
  client._fetch = async (path) => {
    url = path;
    return {
      ok: true,
      text: async () => `<activation><activationOutput><AID>activation-001</AID></activationOutput><activationInput>
        <activationAttribute><attributeName>C2V</attributeName><attributeValue>${encoded}</attributeValue></activationAttribute>
      </activationInput></activation>`,
    };
  };
  assert.equal(await client.getActivationC2V('activation-001'), c2v);
  assert.equal(url, 'https://ems.example/ems/v90/ws/activation/activation-001.ws');

  const nested = '<activation><activationOutput><AID>activation-001</AID></activationOutput><activationInput>' +
    '<activationAttribute><attributeName>C2V</attributeName><attributeValue>' +
    '<hasp_info><haspscope><hasp id="123"/></haspscope><c2v>YWJj</c2v></hasp_info>' +
    '</attributeValue></activationAttribute></activationInput></activation>';
  client._fetch = async () => ({ ok: true, text: async () => nested });
  assert.equal(await client.getActivationC2V('activation-001'),
    '<hasp_info><haspscope><hasp id="123"></hasp></haspscope><c2v>YWJj</c2v></hasp_info>');

  client._fetch = async () => ({
    ok: true,
    text: async () => '<activation><activationOutput><AID>activation-001</AID></activationOutput></activation>',
  });
  await assert.rejects(() => client.getActivationC2V('activation-001'), /activationInput.*found 0/);
});

test('reports saved C2V shape and validation errors without exposing its contents', async () => {
  const client = createClient();
  const record = (attributes) => `<activation><activationOutput><AID>aid-1</AID></activationOutput><activationInput>${attributes}</activationInput></activation>`;
  const attribute = (value) => `<activationAttribute><attributeName>C2V</attributeName><attributeValue>${value}</attributeValue></activationAttribute>`;
  let xml = record(attribute('null'));
  client._fetch = async () => ({ ok: true, text: async () => xml });
  await assert.rejects(() => client.getActivationC2V('aid-1'), /null C2V value.*format: text; size: 4 bytes/);
  xml = record(attribute(''));
  await assert.rejects(() => client.getActivationC2V('aid-1'), /empty C2V value.*size: 0 bytes/);
  xml = record(attribute('&lt;hasp_info&gt;SECRET_FINGERPRINT'));
  await assert.rejects(() => client.getActivationC2V('aid-1'), (error) => {
    assert.match(error.message, /format: text; size: \d+ bytes; XML error: \w+, line \d+, column \d+/);
    assert.doesNotMatch(error.message, /SECRET_FINGERPRINT/);
    assert.equal(error.c2vDiagnostic.format, 'text');
    assert.equal(error.c2vDiagnostic.containsHASPInfoMarkup, true);
    assert.equal(error.c2vDiagnostic.extraEscapingDecoded, false);
    assert.doesNotMatch(JSON.stringify(error.c2vDiagnostic), /SECRET_FINGERPRINT/);
    assert.equal(error.c2vValue, undefined);
    return true;
  });
  xml = record(attribute('&lt;hasp_info&gt;abc &amp; SECRET_FINGERPRINT&lt;/hasp_info&gt;'));
  await assert.rejects(() => client.getActivationC2V('aid-1'), (error) => {
    assert.equal(error.c2vDiagnostic.reason, 'unexpected ampersand');
    assert.doesNotMatch(JSON.stringify(error.c2vDiagnostic), /SECRET_FINGERPRINT/);
    return true;
  });
  xml = record('<activationAttribute><attributeName>OTHER</attributeName><attributeValue>secret</attributeValue></activationAttribute>');
  await assert.rejects(() => client.getActivationC2V('aid-1'), /found 0 among 1 activation attributes/);
});

test('decodes an additional escaped XML layer after the C2V declaration', async () => {
  const client = createClient();
  const c2v = '<?xml version="1.0" encoding="UTF-8"?><hasp_info><haspscope><hasp id="123"/></haspscope><c2v>YWJj</c2v></hasp_info>';
  const declaration = '<?xml version="1.0" encoding="UTF-8"?>';
  const escape = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const stored = declaration + escape(c2v.slice(declaration.length));
  assert.deepEqual(require('fast-xml-parser').XMLValidator.validate(stored).err,
    { code: 'InvalidChar', msg: "char '&' is not expected.", line: 1, col: 39 });
  client._fetch = async () => ({
    ok: true,
    text: async () => `<activation><activationOutput><AID>aid-1</AID></activationOutput><activationInput>` +
      `<activationAttribute><attributeName>C2V</attributeName><attributeValue>${escape(stored)}</attributeValue></activationAttribute>` +
      `</activationInput></activation>`,
  });
  assert.equal(await client.getActivationC2V('aid-1'), c2v);
});

test('decodes escaped carriage returns outside a saved C2V root', async () => {
  const client = createClient();
  const declaration = '<?xml version="1.0" encoding="UTF-8"?>';
  const root = '<hasp_info>&#xd;<host_fingerprint>fingerprint</host_fingerprint>&#xd;</hasp_info>';
  const stored = `${declaration}&#xd;${root}&#xd;`;
  const escape = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let xml = `<activation><activationOutput><AID>aid-1</AID></activationOutput><activationInput>` +
    `<activationAttribute><attributeName>C2V</attributeName><attributeValue>${escape(stored)}</attributeValue></activationAttribute>` +
    `</activationInput></activation>`;
  client._fetch = async () => ({ ok: true, text: async () => xml });
  assert.equal(await client.getActivationC2V('aid-1'), `${declaration}\r${root}\r`);

  xml = xml.replace('&amp;#xd;', '&amp;unknown;');
  await assert.rejects(() => client.getActivationC2V('aid-1'), /invalid saved C2V/);
});

test('posts the C2V without an EMS session and returns the complete V2CP XML', async (t) => {
  const client = createClient();
  client.cookies.set('JSESSIONID', 'private-session');
  const c2v = '<?xml version="1.0"?><hasp_info><haspscope><hasp id="123"/></haspscope><c2v>YWJj</c2v></hasp_info>';
  const v2cp = '<?xml version="1.0"?><hasp_info><haspscope/><v2cp>YWJj\nZA==</v2cp></hasp_info>';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://ems.example/ems/v90/ws/activation/target.ws');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/xml');
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.body, c2v);
    return { ok: true, status: 200, text: async () => v2cp };
  });
  assert.equal(await client.fetchPendingUpdates(c2v), v2cp);
});

test('rejects invalid C2Vs and reports missing or malformed pending updates', async (t) => {
  const client = createClient();
  const c2v = '<hasp_info><haspscope><hasp id="123"/></haspscope><c2v>YWJj</c2v></hasp_info>';
  let response = { ok: false, status: 404 };
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response; });
  await assert.rejects(() => client.fetchPendingUpdates('<broken'), { status: 400 });
  await assert.rejects(() => client.fetchPendingUpdates('<hasp_info/>'), { status: 400 });
  assert.equal(calls, 0);
  await assert.rejects(() => client.fetchPendingUpdates(c2v), { status: 404, message: /404/ });
  response = { ok: false, status: 503, statusText: 'Busy' };
  await assert.rejects(() => client.fetchPendingUpdates(c2v), /503.*retry later/i);
  for (const xml of ['not xml', '<hasp_info><v2cp>not base64!</v2cp></hasp_info>', '<hasp_info/>']) {
    response = { ok: true, status: 200, text: async () => xml };
    await assert.rejects(() => client.fetchPendingUpdates(c2v), /invalid|valid V2CP/i);
  }
});

test('activates with a C2V in CDATA and returns the decoded V2C', async () => {
  const client = createClient();
  client.authenticated = true;
  const c2v = '<?xml version="1.0"?><hasp_info><host_fingerprint><![CDATA[a & b]]></host_fingerprint></hasp_info>';
  const license = '<?xml version="1.0"?><hasp_info><v2c>YWJj</v2c></hasp_info>';
  const encoded = license.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  client._fetch = async (url, options) => {
    assert.equal(url, 'https://ems.example/ems/v90/ws/productKey/key%2F001/activation.ws');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/xml');
    const { XMLParser, XMLValidator } = require('fast-xml-parser');
    assert.equal(XMLValidator.validate(options.body), true);
    const input = new XMLParser({ parseTagValue: false }).parse(options.body);
    assert.equal(input.activation.activationInput.activationAttribute.attributeName, 'C2V');
    assert.equal(input.activation.activationInput.activationAttribute.attributeValue, c2v);
    return { ok: true, status: 200, text: async () => `<activation><activationOutput><AID>aid-1</AID><activationString>${encoded}</activationString></activationOutput></activation>` };
  };
  assert.deepEqual(await client.activateProductKey('key/001', c2v), { aid: 'aid-1', license });
});

test('rejects invalid C2V before posting and reports uncertain activation outcomes', async () => {
  const client = createClient();
  client.authenticated = true;
  let calls = 0;
  client._fetch = async () => { calls++; throw new Error('connection lost'); };
  await assert.rejects(() => client.activateProductKey('key-001', '<invalid'), {
    status: 400, message: /valid XML.*line 1, column/,
  });
  assert.equal(calls, 0);
  await assert.rejects(() => client.activateProductKey('key-001', '<hasp_info/>'), { outcomeUnknown: true });
  assert.equal(calls, 1);
  client._fetch = async () => ({ ok: false, status: 404, text: async () => '' });
  await assert.rejects(() => client.activateProductKey('key-001', '<hasp_info/>'), { status: 400 });
  client._fetch = async () => { throw Object.assign(new Error('connection lost'), { status: 400 }); };
  await assert.rejects(() => client.activateProductKey('key-001', '<hasp_info/>'), { outcomeUnknown: true });
  client._fetch = async () => ({ ok: true, status: 200, text: async () => '<activation/>' });
  await assert.rejects(() => client.activateProductKey('key-001', '<hasp_info/>'), { outcomeUnknown: true });
});

test('reports EMS activation diagnostics without exposing C2V or credentials', async () => {
  const client = new EmsClient({ baseUrl: 'https://ems.example', username: 'secret-user', password: 'secret-password' });
  client.authenticated = true;
  const c2v = '<hasp_info><host_fingerprint>FINGERPRINT1234567890</host_fingerprint></hasp_info>';
  const response = (body, status = 400) => ({
    ok: false, status, statusText: 'Bad Request', text: async () => body,
  });
  for (const body of [
    '<error><errorCode>123</errorCode><errorMessage>Invalid fingerprint</errorMessage></error>',
    '{"error":{"code":123,"message":"Invalid fingerprint"}}',
  ]) {
    client._fetch = async () => response(body);
    await assert.rejects(() => client.activateProductKey('key-001', c2v), (err) => {
      assert.match(err.message, /HTTP 400 Bad Request/);
      assert.match(err.message, /123.*Invalid fingerprint/);
      assert.equal(err.outcomeUnknown, true);
      return true;
    });
  }
  client._fetch = async () => response('Invalid fingerprint FINGERPRINT1234567890 for secret-user secret-password key-001');
  await assert.rejects(() => client.activateProductKey('key-001', c2v), (err) => {
    assert.match(err.message, /Invalid fingerprint/);
    for (const secret of ['FINGERPRINT1234567890', 'secret-user', 'secret-password', 'key-001']) {
      assert.doesNotMatch(err.message, new RegExp(secret));
    }
    return true;
  });
  client._fetch = async () => response('<html><body>Internal error</body></html>', 500);
  await assert.rejects(() => client.activateProductKey('key-001', c2v), /did not provide readable error details/);
  client._fetch = async () => response('The Product key does not exist.', 404);
  await assert.rejects(() => client.activateProductKey('key-001', c2v), {
    status: 400, message: /HTTP 404.*The Product key does not exist/,
  });
  client._fetch = async () => ({ ok: false, status: 404, text: async () => { throw new Error('body interrupted'); } });
  await assert.rejects(() => client.activateProductKey('key-001', c2v), {
    status: 400, message: /HTTP 404.*body interrupted/,
  });
});
