const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EmsClient } = require('../ems-client');

function clientWithResponses(responses) {
  const client = new EmsClient({ baseUrl: 'https://ems.example' });
  client.call = async (url) => {
    assert.ok(Object.hasOwn(responses, url), `Unexpected EMS request: ${url}`);
    return responses[url];
  };
  return client;
}

test('lists product-specific segments only for read-only memory files', async () => {
  const client = clientWithResponses({
    '/product/12.ws': `<product><dynamicMemoriesRef>
      <dynamicMemory><memoryId>1</memoryId><memories>
        <memorySegment><name>First</name><offset>0x0001</offset><size>2</size><content>000A</content></memorySegment>
        <memorySegment><name>Second</name><offset>0x0003</offset><size>1</size><content>00</content></memorySegment>
      </memories></dynamicMemory>
      <dynamicMemory><memoryId>2</memoryId></dynamicMemory>
      <dynamicMemory><memoryId>3</memoryId></dynamicMemory>
    </dynamicMemoriesRef></product>`,
    '/dynamicMemory/1.ws': '<dynamicMemory><memoryName>Read only</memoryName><fileId>4</fileId><memoryType>2</memoryType><memories><memorySegment><name>Default</name></memorySegment></memories></dynamicMemory>',
    '/dynamicMemory/2.ws': '<dynamicMemory><memoryName>Read write</memoryName><memoryType>1</memoryType></dynamicMemory>',
    '/dynamicMemory/3.ws': '<dynamicMemory><memoryName>Other</memoryName><fileId>5</fileId><memoryType>2</memoryType><memories><memorySegment><name>Default</name><content>0000</content></memorySegment></memories></dynamicMemory>',
  });
  const files = await client.getProductReadOnlyMemory('12');
  assert.equal(files.length, 2);
  assert.deepEqual(files[0].segments.map(({ name, content, offset }) => ({ name, content, offset })), [
    { name: 'First', content: '000A', offset: '0x0001' },
    { name: 'Second', content: '00', offset: '0x0003' },
  ]);
  assert.equal(files[1].segments[0].content, '0000');
});

test('handles no references, empty segment lists, and invalid EMS data explicitly', async () => {
  assert.deepEqual(await clientWithResponses({ '/product/1.ws': '<product><productName>None</productName></product>' }).getProductReadOnlyMemory('1'), []);
  const client = clientWithResponses({
    '/product/2.ws': '<product><dynamicMemoriesRef><dynamicMemory><memoryId>3</memoryId><memories/></dynamicMemory></dynamicMemoriesRef></product>',
    '/dynamicMemory/3.ws': '<dynamicMemory><memoryType>2</memoryType><memories><memorySegment><name>Default</name></memorySegment></memories></dynamicMemory>',
  });
  assert.deepEqual((await client.getProductReadOnlyMemory(2))[0].segments, []);
  await assert.rejects(() => client.getProductReadOnlyMemory('../2'), /positive number/);
  await assert.rejects(() => clientWithResponses({
    '/product/1.ws': '<product><dynamicMemoriesRef><dynamicMemory><memoryId>3</memoryId></dynamicMemory></dynamicMemoriesRef></product>',
    '/dynamicMemory/3.ws': '<dynamicMemory><memoryType>unknown</memoryType></dynamicMemory>',
  }).getProductReadOnlyMemory(1), /invalid details/);
});

test('lists read-only product memory segments separately from dynamic memory', async () => {
  const client = clientWithResponses({
    '/product/4.ws': `<product>
      <memorySegment><name>Static RO</name><text>000F</text><offset>0x0000</offset><memoryType><id>2</id></memoryType></memorySegment>
      <memorySegment><name>Static RW</name><memoryType><id>1</id></memoryType></memorySegment>
    </product>`,
  });
  const files = await client.getProductReadOnlyMemory(4);
  assert.equal(files.length, 1);
  assert.equal(files[0].kind, 'product');
  assert.equal(files[0].segments.length, 1);
  assert.equal(files[0].segments[0].name, 'Static RO');
  assert.equal(files[0].segments[0].content, '000F');
  await assert.rejects(() => clientWithResponses({
    '/product/1.ws': '<product><memorySegment><name>Unknown</name></memorySegment></product>',
  }).getProductReadOnlyMemory(1), /valid memory type/);
});

test('reports an EMS login redirect as an expired session', async () => {
  const client = clientWithResponses({});
  client.call = async () => { const error = new Error('Redirect'); error.status = 302; throw error; };
  await assert.rejects(() => client.getProductReadOnlyMemory(1), { status: 401 });
});

function entitlementApp(fetch) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'entitlements.html'), 'utf8');
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  let definition;
  vm.runInNewContext(script, {
    fetch,
    Vue: { createApp: (options) => { definition = options; return { mount() {} }; } },
  });
  const app = { ...definition.methods };
  Object.assign(app, definition.data.call(app));
  Object.defineProperty(app, 'availableProducts', { get: () => definition.computed.availableProducts.call(app) });
  return app;
}

test('adding and removing products loads their memory without stale responses', async () => {
  const pending = [];
  const app = entitlementApp((url) => new Promise((resolve) => pending.push({ url, resolve })));
  app.products = [{ productId: 12, productName: 'Product' }];
  app.form.productToAdd = '12';
  app.addProduct();
  assert.equal(pending[0].url, '/api/catalog/products/12/read-only-memory');
  assert.equal(app.productMemory['12'].loading, true);
  app.removeProduct('12');
  app.form.productToAdd = '12';
  app.addProduct();
  pending[0].resolve({ ok: true, json: async () => [{ memoryId: 'old' }] });
  await new Promise(setImmediate);
  assert.equal(app.productMemory['12'].loading, true);
  pending[1].resolve({ ok: true, json: async () => [{ memoryId: 'new', segments: [] }] });
  await new Promise(setImmediate);
  assert.equal(app.productMemory['12'].files[0].memoryId, 'new');
  assert.equal(app.productMemory['12'].loading, false);
});

test('memory lookup failures are visible and can be retried', async () => {
  let attempt = 0;
  const app = entitlementApp(async () => ++attempt === 1
    ? { ok: false, statusText: 'Bad gateway', json: async () => ({ error: 'EMS unavailable' }) }
    : { ok: true, json: async () => [] });
  await app.loadProductMemory('12');
  assert.match(app.productMemory['12'].error, /EMS unavailable/);
  await app.loadProductMemory('12');
  assert.equal(app.productMemory['12'].error, '');
  assert.equal(app.productMemory['12'].files.length, 0);
});
