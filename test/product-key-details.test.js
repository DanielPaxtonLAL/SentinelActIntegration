const test = require('node:test');
const assert = require('node:assert/strict');
const { EmsClient } = require('../ems-client');

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
