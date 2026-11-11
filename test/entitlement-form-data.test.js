const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadFormData, parseFormData } = require('../entitlement-form-data');

const valid = () => ({
  _comment: 'ignored',
  'base-product-id': '1',
  'product-options': { a: { label: 'A', 'product-id': '2' } },
  'optional-products': {},
  version: { v1: { label: 'V1', 'product-id': '' }, v2: { label: 'V2', 'product-id': '3' } },
  lease: { lease: { label: 'Lease', 'product-id': '4' } },
});

test('repo form data file loads', () => {
  const data = loadFormData(path.join(__dirname, '..', 'entitlement-form-data.json'));
  assert.ok(data.baseProductId);
  assert.ok(data.accessProducts.length >= 1);
  assert.ok(data.lease.id);
});

test('parses ids, labels and default version', () => {
  const data = parseFormData(valid());
  assert.equal(data.baseProductId, '1');
  assert.deepEqual(data.accessProducts, [{ id: '2', label: 'A' }]);
  assert.equal(data.defaultVersionLabel, 'V1');
  assert.deepEqual(data.versionProducts.map((p) => p.id), ['3']);
  assert.equal(data.lease.id, '4');
});

test('rejects duplicate ids and missing sections', () => {
  const dup = valid();
  dup.version.v2['product-id'] = '2';
  assert.throws(() => parseFormData(dup));
  const none = valid();
  none['product-options'] = {};
  assert.throws(() => parseFormData(none));
  const noBase = valid();
  delete noBase['base-product-id'];
  assert.throws(() => parseFormData(noBase));
});
