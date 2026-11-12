const test = require('node:test');
const assert = require('node:assert/strict');
const { XMLParser } = require('fast-xml-parser');
const { EmsClient } = require('../ems-client');

const xml = `<?xml version="1.0"?><entitlement><eid>abc</eid><enabled>true</enabled>
<entState>DRAFT</entState><customerId>10</customerId><refId1>00123</refId1>
<entitlementItem><lineItemType>Product_Key</lineItemType><itemProduct><productId>60</productId></itemProduct>
<memorySegments><segment><data>30303032</data></segment></memorySegments></entitlementItem></entitlement>`;

function clientWith(xmlBody = xml, post = { ok: true, status: 200 }) {
  const client = new EmsClient({ baseUrl: 'https://ems.example' });
  client.authenticated = true;
  const requests = [];
  client._fetch = async (url, options) => {
    requests.push({ url, options });
    return options.method === 'POST' ? post : {
      ok: true, status: 200, text: async () => requests.length > 1 ? xmlBody.replace('DRAFT', 'PRODUCED') : xmlBody,
    };
  };
  return { client, requests };
}

test('produces using the unchanged fetched entitlement with PRODUCE action', async () => {
  const { client, requests } = clientWith();
  assert.deepEqual(await client.produceEntitlement('123'), { produced: true, entId: '123', state: 'PRODUCED' });
  assert.equal(requests[0].url, 'https://ems.example/ems/v90/ws/entitlement/123.xml');
  assert.equal(requests[1].url, 'https://ems.example/ems/v90/ws/entitlement/123.ws');
  assert.equal(requests[1].options.method, 'POST');
  const parser = new XMLParser({ parseTagValue: false });
  const expected = parser.parse(xml);
  expected.entitlement.action = 'PRODUCE';
  assert.deepEqual(parser.parse(requests[1].options.body), expected);
});

test('confirms production when EMS reports PRODUCT_KEY_GENERATED', async () => {
  const { client, requests } = clientWith();
  client._fetch = async (_url, options) => {
    requests.push(options);
    return options.method === 'POST'
      ? { ok: true }
      : { ok: true, text: async () => requests.length === 1 ? xml : xml.replace('DRAFT', 'PRODUCT_KEY_GENERATED') };
  };
  assert.deepEqual(await client.produceEntitlement('123'), { produced: true, entId: '123', state: 'PRODUCT_KEY_GENERATED' });
  assert.equal(requests.filter((options) => options.method === 'POST').length, 1);
});

test('rejects invalid IDs, non-drafts, non-product-key items and malformed XML before posting', async () => {
  for (const body of [xml.replace('DRAFT', 'PRODUCED'), xml.replace('Product_Key', 'Hardware_Key'),
    xml.replace('</entitlement>', '<action>SAVE</action></entitlement>'), '<bad']) {
    const { client, requests } = clientWith(body);
    await assert.rejects(() => client.produceEntitlement('123'));
    assert.equal(requests.length, 1);
  }
  const { client, requests } = clientWith();
  await assert.rejects(() => client.produceEntitlement('../123'));
  assert.equal(requests.length, 0);
});

test('POST failure is reported as an uncertain outcome', async () => {
  const { client } = clientWith(xml, { ok: false, status: 500, statusText: 'Error' });
  await assert.rejects(() => client.produceEntitlement('123'), { outcomeUnknown: true });
  client._fetch = async (_url, options) => {
    if (options.method === 'POST') throw new Error('connection lost');
    return { ok: true, status: 200, text: async () => xml };
  };
  await assert.rejects(() => client.produceEntitlement('123'), { outcomeUnknown: true });
});

test('an unconfirmed state after POST is reported as uncertain', async () => {
  const { client, requests } = clientWith();
  client._fetch = async (_url, options) => {
    requests.push(options);
    return options.method === 'POST' ? { ok: true } : { ok: true, text: async () => xml };
  };
  await assert.rejects(() => client.produceEntitlement('123'), { outcomeUnknown: true });
  assert.equal(requests.filter((options) => options.method === 'POST').length, 1);
});

test('preserves attributes, comments, CDATA and leading zeroes', async () => {
  const source = xml.replace('<customerId>10</customerId>', '<!-- keep --><customerId code="001">10</customerId><description><![CDATA[Part <A>]]></description>');
  const { client, requests } = clientWith(source);
  await client.produceEntitlement('123');
  const body = requests[1].options.body;
  assert.match(body, /<!-- keep -->/);
  assert.match(body, /code="001"/);
  assert.match(body, /<!\[CDATA\[Part <A>\]\]>/);
  assert.match(body, /<refId1>00123<\/refId1>/);
});
