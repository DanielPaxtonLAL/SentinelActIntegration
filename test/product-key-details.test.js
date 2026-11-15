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
