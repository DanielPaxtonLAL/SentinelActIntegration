const test = require('node:test');
const assert = require('node:assert/strict');
const LeaseDates = require('../public/lease-dates');

test('lease expiry bounds are inclusive calendar months from start and never in the past', () => {
  const range = { minMonths: 6, maxMonths: 24 };
  assert.deepEqual(LeaseDates.bounds('2026-11-12', '2026-11-12', range), {
    min: '2027-05-12', max: '2028-11-12',
  });
  for (const date of ['2027-05-12', '2028-11-12']) {
    assert.doesNotThrow(() => LeaseDates.validate(date, '2026-11-12', '2026-11-12', range));
  }
  for (const date of ['2026-11-11', '2027-05-11', '2028-11-13']) {
    assert.throws(() => LeaseDates.validate(date, '2026-11-12', '2026-11-12', range), /between/);
  }
  assert.deepEqual(LeaseDates.bounds('2024-01-31', '2024-01-31', range), {
    min: '2024-07-31', max: '2026-01-31',
  });
  assert.equal(LeaseDates.addMonths('2024-08-31', 6), '2025-02-28');
  assert.equal(LeaseDates.addMonths('2024-02-29', 12), '2025-02-28');
  assert.throws(() => LeaseDates.validate('2027-05-12', '2026-11-12', '2027-05-13', range), /not in the past/);
  assert.doesNotThrow(() => LeaseDates.validate('2027-05-13', '2026-11-12', '2027-05-13', range));
  assert.throws(() => LeaseDates.decode('1234abcd'), /Invalid/);
});
