const test = require('node:test');
const assert = require('node:assert/strict');
const { XMLParser } = require('fast-xml-parser');
const { EmsClient } = require('../ems-client');

const customerXml = `<?xml version="1.0"?>
<customer><type>org</type><enabled>true</enabled><name>Test &amp; Company</name>
<description>Keep this</description><crmId>crm-1</crmId><refId>00042</refId>
<phone>555</phone><addresses><address><type>billing</type><city>Here</city></address></addresses>
<vendorId>2</vendorId><defaultContact><emailId>example@example.invalid</emailId></defaultContact></customer>`;

function setup(xml = customerXml) {
  const client = new EmsClient({ baseUrl: 'https://ems.example', serialNumberCustomerId: '1010' });
  client.authenticated = true;
  const requests = [];
  client._fetch = async (url, options) => {
    requests.push({ url, options });
    return { status: 200, ok: true, text: async () => xml };
  };
  return { client, requests };
}

test('reads the configured customer reference ID as a serial number', async () => {
  const { client, requests } = setup();
  assert.equal(await client.getLargestProductKeySerial(), 42);
  assert.equal(requests[0].url, 'https://ems.example/ems/v90/ws/customer/1010.ws');
  assert.equal(requests[0].options.method, undefined);
});

test('posts the changed reference while preserving the other customer fields', async () => {
  const { client, requests } = setup();
  await client.setLargestProductKeySerial(65535);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, requests[0].url);
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(requests[1].options.headers['Content-Type'], 'application/xml');
  const parser = new XMLParser({ parseTagValue: false });
  const before = parser.parse(customerXml);
  const after = parser.parse(requests[1].options.body);
  assert.equal(after.customer.refId, '65535');
  before.customer.refId = '65535';
  assert.deepEqual(after, before);
});

test('rejects invalid input and malformed or ambiguous customer references', async () => {
  const { client, requests } = setup();
  for (const value of [-1, 65536, 1.5, '', 'not a number', undefined]) {
    await assert.rejects(() => client.setLargestProductKeySerial(value), /whole number/);
  }
  assert.equal(requests.length, 0);
  for (const xml of ['not xml', '<customer><name>x</name></customer>',
    '<customer><refId>1</refId><refId>2</refId></customer>',
    '<customer><refId>not a number</refId></customer>']) {
    await assert.rejects(() => setup(xml).client.getLargestProductKeySerial());
  }
  const noId = setup().client;
  noId.serialNumberCustomerId = '../1010';
  await assert.rejects(() => noId.getLargestProductKeySerial(), /Configure a valid/);
});

test('propagates customer lookup and update errors', async () => {
  const { client } = setup();
  client._fetch = async () => ({ status: 302, ok: false, text: async () => '' });
  await assert.rejects(() => client.getLargestProductKeySerial(), { status: 401 });
  let calls = 0;
  client._fetch = async () => ++calls === 1
    ? { status: 200, ok: true, text: async () => customerXml }
    : { status: 500, statusText: 'Error', ok: false, text: async () => 'Failure' };
  await assert.rejects(() => client.setLargestProductKeySerial(43), { status: 500, body: 'Failure' });
});
