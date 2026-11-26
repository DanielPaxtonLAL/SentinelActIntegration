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

test('startup seeds the next serial above the highest existing serial, leaving gaps', async () => {
  const { initializeNextProductKeySerial } = coordinator();
  const events = [];
  const ems = {
    async listEntitlementsForActivations() { events.push('list'); return [{ id: '1' }, { id: '2' }, { id: '3' }]; },
    async getEntitlementDetails(id) {
      events.push(`detail:${id}`);
      const serial = { 1: '31373731', 2: '31373738', 3: '31373733' }[id];
      return {
        id,
        products: [{
          productId: '60',
          memorySegments: [{ name: 'Serial Number', saot: true, text: serial }],
        }],
      };
    },
    async setNextProductKeySerial(value) { events.push(`write:${value}`); },
  };
  assert.equal(await initializeNextProductKeySerial(ems), 6009);
  assert.deepEqual(events, ['list', 'detail:1', 'detail:2', 'detail:3', 'write:6009']);
});

test('startup ignores out-of-range serials while choosing the highest valid serial above 06000', async () => {
  const { initializeNextProductKeySerial } = coordinator();
  let stored;
  const ems = {
    async listEntitlementsForActivations() { return [{ id: '1' }, { id: '2' }, { id: '3' }]; },
    async getEntitlementDetails(id) {
      return {
        id,
        products: [{
          productId: '60',
          memorySegments: [{
            name: 'Serial Number',
            saot: true,
            text: { 1: 'FFFFFFFF', 2: '31373738', 3: '30303031' }[id],
          }],
        }],
      };
    },
    async setNextProductKeySerial(value) { stored = value; },
  };
  assert.equal(await initializeNextProductKeySerial(ems), 6009);
  assert.equal(stored, 6009);
});

test('startup starts at 06001 when no valid serial exceeds 06000', async () => {
  const { initializeNextProductKeySerial } = coordinator();
  let stored;
  const ems = {
    async listEntitlementsForActivations() { return [{ id: '1' }]; },
    async getEntitlementDetails(id) {
      return {
        id,
        products: [{
          productId: '60',
          memorySegments: [{ name: 'Serial Number', saot: true, text: '31373730' }],
        }],
      };
    },
    async setNextProductKeySerial(value) { stored = value; },
  };
  assert.equal(await initializeNextProductKeySerial(ems), 6001);
  assert.equal(stored, 6001);
});

test('startup stores the exhausted sentinel after serial 65,535', async () => {
  const { initializeNextProductKeySerial } = coordinator();
  let stored;
  const ems = {
    async listEntitlementsForActivations() { return [{ id: '1' }]; },
    async getEntitlementDetails(id) {
      return {
        id,
        products: [{
          productId: '60',
          memorySegments: [{ name: 'Serial Number', saot: true, text: 'FFFF' }],
        }],
      };
    },
    async setNextProductKeySerial(value) { stored = value; },
  };
  assert.equal(await initializeNextProductKeySerial(ems), 65536);
  assert.equal(stored, 65536);
});

test('does not overwrite the counter when entitlement memory cannot be checked', async () => {
  const { initializeNextProductKeySerial } = coordinator();
  let written = false;
  const ems = {
    async listEntitlementsForActivations() { return [{ id: '1' }]; },
    async getEntitlementDetails() { return { id: '1', products: [{ productId: '60', memorySegments: [] }] }; },
    async setNextProductKeySerial() { written = true; },
  };
  await assert.rejects(() => initializeNextProductKeySerial(ems), /Serial Number segment/);
  assert.equal(written, false);
});

test('counter advances only when the saved serial matches and recovers after failure', async () => {
  const { advanceProductKeySerial } = coordinator();
  const events = [];
  let reads = 0;
  const ems = {
    async getNextProductKeySerial() {
      events.push('read');
      if (++reads === 1) throw new Error('read failed');
      return 6003;
    },
    async setNextProductKeySerial(value) { events.push(`write:${value}`); },
  };
  const first = advanceProductKeySerial(ems, 6003);
  const second = advanceProductKeySerial(ems, 6003);
  await assert.rejects(first, /read failed/);
  assert.equal(await second, 6004);
  assert.deepEqual(events, ['read', 'read', 'write:6004']);
});
