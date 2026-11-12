const test = require('node:test');
const assert = require('node:assert/strict');
const { XMLParser } = require('fast-xml-parser');
const { EmsClient } = require('../ems-client');

const xml = `<entitlement><eid>example</eid><enabled>true</enabled><entState>DRAFT</entState>
<customerId>5</customerId><description>old</description><refId1>00123</refId1><refId2>00009</refId2>
<policy><customSetting>unchanged</customSetting></policy><entitlementItem>
<lineItemType>Product_Key</lineItemType><numProductKeys>5</numProductKeys>
<itemProduct><productId>60</productId><product><memorySegment><id>91</id></memorySegment></product></itemProduct>
<itemProduct><productId>6048</productId><product><memorySegment><id>92</id></memorySegment></product></itemProduct>
<itemProduct><productId>77</productId><product><memorySegment><id>93</id></memorySegment></product></itemProduct>
<memorySegments><segment><prdMemorySegmentId>91</prdMemorySegmentId><data>30303031</data></segment>
<segment><prdMemorySegmentId>92</prdMemorySegmentId><data>CAFE</data></segment>
<segment><prdMemorySegmentId>93</prdMemorySegmentId><data>BEEF</data></segment></memorySegments>
</entitlementItem></entitlement>`;

function clientWith(source = xml) {
  const client = new EmsClient({ baseUrl: 'https://ems.example' });
  client.authenticated = true;
  client.getEntitlement = async () => source;
  let posted;
  client._fetch = async (_url, options) => {
    posted = options.body;
    return { ok: true, status: 200, text: async () => '' };
  };
  return { client, getPosted: () => posted };
}
const update = {
  eid: 'example', customerId: '5', description: 'new',
  productIds: ['60', '6049'], editableProductIds: ['6048', '6049'],
  changedMemorySegmentIds: ['91'],
  memorySegments: [{ id: '91', content: '30303032' }],
};

test('preserves unedited fields and unsupported products and their memory', async () => {
  const { client, getPosted } = clientWith();
  await client.updateEntitlement('123', update);
  const result = new XMLParser({ parseTagValue: false }).parse(getPosted()).entitlement;
  assert.equal(result.refId1, '00123');
  assert.equal(result.refId2, '00009');
  assert.equal(result.policy.customSetting, 'unchanged');
  assert.equal(result.entitlementItem.numProductKeys, '5');
  assert.deepEqual(result.entitlementItem.itemProduct.map((product) => product.productId), ['60', '77', '6049']);
  const segments = result.entitlementItem.memorySegments.segment;
  assert.deepEqual(segments.map((segment) => segment.prdMemorySegmentId), ['91', '93']);
  assert.equal(segments[0].data, '30303032');
  assert.equal(segments[1].data, 'BEEF');
});

test('does not post if the draft structure or state is ambiguous', async () => {
  for (const source of [xml.replace('DRAFT', 'PRODUCT_KEY_GENERATED'),
    xml.replace('</entitlement>', '<entitlementItem><lineItemType>Product_Key</lineItemType></entitlementItem></entitlement>')]) {
    const { client, getPosted } = clientWith(source);
    await assert.rejects(() => client.updateEntitlement('123', update));
    assert.equal(getPosted(), undefined);
  }
});
