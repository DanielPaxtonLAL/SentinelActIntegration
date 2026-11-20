const test = require('node:test');
const assert = require('node:assert/strict');
const { createProductKeySerials } = require('../src/product-key-serials');

const coordinator = () => createProductKeySerials({
  baseProductId: '60',
  withSession: (_ems, operation) => operation(),
});

test('serial save lock releases after failure and runs waiting operations in order', async () => {
  const { withProductKeySerialLock } = coordinator();
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = withProductKeySerialLock(async () => {
    events.push('first');
    await gate;
    throw new Error('save failed');
  });
  const second = withProductKeySerialLock(async () => { events.push('second'); });
  await Promise.resolve();
  assert.deepEqual(events, ['first']);
  release();
  await assert.rejects(first, /save failed/);
  await second;
  assert.deepEqual(events, ['first', 'second']);
});

test('counter updates remain serialized and recover after an unsuccessful read', async () => {
  const { incrementProductKeySerial } = coordinator();
  const events = [];
  let reads = 0;
  const ems = {
    async getLargestProductKeySerial() {
      events.push('read');
      if (++reads === 1) throw new Error('read failed');
      return 3;
    },
    async setLargestProductKeySerial(value) { events.push(`write:${value}`); },
  };
  const first = incrementProductKeySerial(ems);
  const second = incrementProductKeySerial(ems);
  await assert.rejects(first, /read failed/);
  assert.equal(await second, 4);
  assert.deepEqual(events, ['read', 'read', 'write:4']);
});
