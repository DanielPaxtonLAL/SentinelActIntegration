const test = require('node:test');
const assert = require('node:assert/strict');
const { XMLParser } = require('fast-xml-parser');
const { EmsClient } = require('../ems-client');

const generatedXml = `<entitlement><eid>abc</eid><enabled>true</enabled>
<entState>PRODUCT_KEY_GENERATED</entState><customerId>10</customerId>
<entitlementItem><lineItemType>Product_Key</lineItemType>
<itemProduct><productId>60</productId></itemProduct></entitlementItem></entitlement>`;

function clientWith(currentXml = generatedXml) {
  const client = new EmsClient({ baseUrl: 'https://ems.example' });
  client.authenticated = true;
  const requests = [];
  client._fetch = async (url, options) => {
    requests.push({ url, options });
    if (options.method === 'POST') return { ok: true, status: 200, text: async () => '' };
    const xml = requests.length === 1 ? currentXml : currentXml.replace(/<entState>[^<]+/, '<entState>DRAFT');
    return { ok: true, status: 200, text: async () => xml };
  };
  return { client, requests };
}

test('reopens generated entitlements with REOPEN and confirms the draft state', async () => {
  const { client, requests } = clientWith();
  assert.deepEqual(await client.reopenEntitlement('123'), {
    reopened: true,
    entId: '123',
    state: 'DRAFT',
  });
  assert.equal(requests[0].url, 'https://ems.example/ems/v90/ws/entitlement/123.xml');
  assert.equal(requests[1].url, 'https://ems.example/ems/v90/ws/entitlement/123.ws');
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(new XMLParser({ parseTagValue: false }).parse(requests[1].options.body).entitlement.action, 'REOPEN');
});

test('rejects invalid IDs, ineligible states, and non-Product-Key entitlements before posting', async () => {
  const { client, requests } = clientWith(generatedXml.replace('PRODUCT_KEY_GENERATED', 'DRAFT'));
  await assert.rejects(() => client.reopenEntitlement('123'), /Only queued or Product Key generated/);
  await assert.rejects(() => client.reopenEntitlement('../123'), /positive number/);
  const nonProductKey = clientWith(generatedXml.replace('Product_Key', 'Hardware_Key'));
  await assert.rejects(() => nonProductKey.client.reopenEntitlement('123'), /Only queued or Product Key generated/);
  assert.equal(requests.length, 1);
  assert.equal(nonProductKey.requests.length, 1);
});

test('reports uncertain outcomes when EMS does not confirm reopening', async () => {
  const { client } = clientWith();
  client._fetch = async (_url, options) => options.method === 'POST'
    ? { ok: false, status: 500, statusText: 'Error' }
    : { ok: true, status: 200, text: async () => generatedXml };
  await assert.rejects(() => client.reopenEntitlement('123'), { outcomeUnknown: true });
});
