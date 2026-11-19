const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadFormData, parseFormData } = require('../entitlement-form-data');

const ids = (testId, productionId) => ({
  'test-ems-server-product-id': testId,
  'production-ems-server-product-id': productionId,
});
const valid = () => ({
  _comment: 'ignored',
  'base-product-id': ids('1', '11'),
  'lease-expiry-range': { 'min-months': 6, 'max-months': 24 },
  'product-options': { a: { label: 'A', ...ids('2', '12') } },
  'optional-products': {},
  version: { v1: { label: 'V1', ...ids('', '') }, v2: { label: 'V2', ...ids('3', '13') } },
  lease: { lease: { label: 'Lease', ...ids('4', '14') } },
});

test('repo form data selects the original product IDs for each EMS server', () => {
  const file = path.join(__dirname, '..', 'entitlement-form-data.json');
  for (const [isTestMode, expected] of [
    [true, ['6047', '6048', '6049', '6051', '6052', '6050']],
    [false, ['1', '25', '24', '22', '21', '34']],
  ]) {
    const data = loadFormData(file, isTestMode);
    assert.deepEqual([
      data.baseProductId, ...data.accessProducts.map((p) => p.id),
      ...data.optionalProducts.map((p) => p.id), ...data.versionProducts.map((p) => p.id), data.lease.id,
    ], expected);
    assert.equal(data.defaultVersionLabel, 'Version 22');
    assert.equal(data.highestProductKeySerialNumberCustomerId, '1');
    assert.deepEqual(data.leaseExpiryRange, { minMonths: 6, maxMonths: 13 });
  }
});

test('parses ids, labels and default version', () => {
  const data = parseFormData(valid(), true);
  assert.equal(data.baseProductId, '1');
  assert.deepEqual(data.accessProducts, [{ id: '2', label: 'A' }]);
  assert.equal(data.defaultVersionLabel, 'V1');
  assert.deepEqual(data.versionProducts.map((p) => p.id), ['3']);
  assert.equal(data.lease.id, '4');
  assert.deepEqual(data.leaseExpiryRange, { minMonths: 6, maxMonths: 24 });
  assert.deepEqual(data.productAliases, [
    { alias: 'a', id: '2', group: 'product' },
    { alias: 'v1', id: '', group: 'version' },
    { alias: 'v2', id: '3', group: 'version' },
    { alias: 'lease', id: '4', group: 'lease' },
  ]);
  const production = parseFormData(valid(), false);
  assert.equal(production.baseProductId, '11');
  assert.equal(production.accessProducts[0].id, '12');
  assert.equal(production.versionProducts[0].id, '13');
  assert.equal(production.lease.id, '14');
});

test('rejects duplicate ids and missing sections', () => {
  const dup = valid();
  dup.version.v2['production-ems-server-product-id'] = '12';
  assert.throws(() => parseFormData(dup, true), /used more than once/);
  const none = valid();
  none['product-options'] = {};
  assert.throws(() => parseFormData(none, true));
  const noBase = valid();
  delete noBase['base-product-id'];
  assert.throws(() => parseFormData(noBase, true));
  const invalidRange = valid();
  invalidRange['lease-expiry-range']['min-months'] = 25;
  assert.throws(() => parseFormData(invalidRange, true), /lease-expiry-range/);
  const missingRange = valid();
  delete missingRange['lease-expiry-range'];
  assert.throws(() => parseFormData(missingRange, true), /lease-expiry-range/);
  const invalidCustomer = valid();
  invalidCustomer['highest-product-key-serial-number-customer-id'] = '../1010';
  assert.throws(() => parseFormData(invalidCustomer, true), /highest-product-key-serial-number-customer-id/);
});

test('requires valid IDs for both servers and an explicit mode', () => {
  const missing = valid();
  delete missing.version.v1['production-ems-server-product-id'];
  assert.throws(() => parseFormData(missing, true), /production-ems-server-product-id/);
  const invalid = valid();
  invalid['product-options'].a['test-ems-server-product-id'] = 'not-an-id';
  assert.throws(() => parseFormData(invalid, false), /test-ems-server-product-id/);
  const required = valid();
  required.lease.lease['production-ems-server-product-id'] = '';
  assert.throws(() => parseFormData(required, true), /lease/);
  assert.throws(() => parseFormData(valid()), /test mode must be a boolean/);
});
