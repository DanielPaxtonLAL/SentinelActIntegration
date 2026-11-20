const test = require('node:test');
const assert = require('node:assert/strict');
const { XMLParser } = require('fast-xml-parser');
const { EmsClient } = require('../src/ems-client');

test('builds protection-key updates with escaped values and the requested update count', () => {
  const client = new EmsClient({ baseUrl: 'https://ems.example' });
  const description = `A < B & "quoted" 'value'`;
  const { entitlementXml, lineItemType } = client.buildEntitlementXml({
    lineItemType: 'ProtectionKey_Update',
    customerId: '5',
    productIds: ['60', '61'],
    numberOfUpdates: 3,
    haspIds: ['key<1', 'key&2'],
    vendorId: '2',
    enforcementId: '1',
    startDate: '2026-01-01',
    endDate: '2500-12-31',
    refId1: '00123',
    refId2: '',
    description,
    memorySegments: [],
  });
  const parsed = new XMLParser({ parseTagValue: false }).parse(entitlementXml).entitlement;
  assert.equal(lineItemType, 'ProtectionKey_Update');
  assert.equal(parsed.description, description);
  assert.equal(parsed.refId1, '00123');
  assert.deepEqual(parsed.entitlementItem.haspId, ['key<1', 'key&2']);
  assert.equal(parsed.entitlementItem.numActivationPerProductKey, '3');
  assert.equal(parsed.entitlementItem.numProductKeys, '1');
  assert.deepEqual(parsed.entitlementItem.itemProduct.map((product) => product.productId), ['60', '61']);
});

test('rejects unsupported line items and duplicate or missing products', () => {
  const client = new EmsClient({ baseUrl: 'https://ems.example' });
  assert.throws(() => client.buildEntitlementXml({ lineItemType: 'unknown', productIds: ['1'] }), /Unsupported/);
  assert.throws(() => client.buildEntitlementXml({ lineItemType: 'Product_Key', productIds: [] }), /unique product/);
  assert.throws(() => client.buildEntitlementXml({ lineItemType: 'Product_Key', productIds: [1, '1'] }), /unique product/);
});
