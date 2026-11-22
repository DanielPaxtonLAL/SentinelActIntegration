const test = require('node:test');
const assert = require('node:assert/strict');
const { XMLParser } = require('fast-xml-parser');
const { EmsClient } = require('../src/ems-client');

const customerXml = `<?xml version="1.0"?>
<customer><type>org</type><enabled>true</enabled><name>Test &amp; Company</name>
<description>Keep this</description><crmId>crm-1</crmId><refId>{"NextSerial":"06003"}</refId>
<phone>555</phone><addresses><address><type>billing</type><city>Here</city></address></addresses>
<vendorId>2</vendorId><defaultContact><emailId>example@example.invalid</emailId></defaultContact></customer>`;

function setup(xml = customerXml) {
  const client = new EmsClient({ baseUrl: 'https://ems.example', nextSerialNumberCustomerId: '1010' });
  client.authenticated = true;
  const requests = [];
  client._fetch = async (url, options) => {
    requests.push({ url, options });
    return { status: 200, ok: true, text: async () => xml };
  };
  return { client, requests };
}

test('reads the configured customer JSON reference ID as the next serial number', async () => {
  const { client, requests } = setup();
  assert.equal(await client.getNextProductKeySerial(), 6003);
  assert.equal(requests[0].url, 'https://ems.example/ems/v90/ws/customer/1010.ws');
  assert.equal(requests[0].options.method, undefined);
});

test('posts the padded next serial in JSON while preserving the other customer fields', async () => {
  const { client, requests } = setup();
  await client.setNextProductKeySerial(6004);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, requests[0].url);
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(requests[1].options.headers['Content-Type'], 'application/xml');
  assert.match(requests[1].options.body, /<refId>\{"NextSerial":"06004"\}<\/refId>/);
  const parser = new XMLParser({ parseTagValue: false });
  const before = parser.parse(customerXml);
  const after = parser.parse(requests[1].options.body);
  assert.equal(after.customer.refId, '{"NextSerial":"06004"}');
  before.customer.refId = '{"NextSerial":"06004"}';
  assert.deepEqual(after, before);
});

test('reads and repairs a reference stored with literal quote entities', async () => {
  const xml = customerXml.replace('{"NextSerial":"06003"}', '{&amp;quot;NextSerial&amp;quot;:&amp;quot;06003&amp;quot;}');
  const { client, requests } = setup(xml);
  assert.equal(await client.getNextProductKeySerial(), 6003);
  await client.setNextProductKeySerial(6004);
  assert.match(requests[2].options.body, /<refId>\{"NextSerial":"06004"\}<\/refId>/);
});

test('reads the exhausted sentinel after serial 65,535', async () => {
  const xml = customerXml.replace('{"NextSerial":"06003"}', '{"NextSerial":"65536"}');
  const { client } = setup(xml);
  assert.equal(await client.getNextProductKeySerial(), 65536);
});

test('rejects invalid input and malformed or ambiguous customer references', async () => {
  const { client, requests } = setup();
  for (const value of [6000, 65537, 1.5, '', 'not a number', undefined]) {
    await assert.rejects(() => client.setNextProductKeySerial(value), /whole number/);
  }
  assert.equal(requests.length, 0);
  for (const xml of ['not xml', '<customer><name>x</name></customer>',
    '<customer><refId>1</refId><refId>2</refId></customer>',
    '<customer><refId>not json</refId></customer>',
    '<customer><refId>{"NextSerial":"6003"}</refId></customer>']) {
    await assert.rejects(() => setup(xml).client.getNextProductKeySerial());
  }
  const noId = setup().client;
  noId.nextSerialNumberCustomerId = '../1010';
  await assert.rejects(() => noId.getNextProductKeySerial(), /Configure a valid/);
});

test('propagates customer lookup and update errors', async () => {
  const { client } = setup();
  client._fetch = async () => ({ status: 302, ok: false, text: async () => '' });
  await assert.rejects(() => client.getNextProductKeySerial(), { status: 401 });
  let calls = 0;
  client._fetch = async () => ++calls === 1
    ? { status: 200, ok: true, text: async () => customerXml }
    : { status: 500, statusText: 'Error', ok: false, text: async () => 'Failure' };
  await assert.rejects(() => client.setNextProductKeySerial(6004), { status: 500, body: 'Failure' });
});
