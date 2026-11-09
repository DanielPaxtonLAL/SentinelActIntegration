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

test('only returns modifications belonging to the selected base product', async () => {
  const client = clientWithResponses({
    '/product/1.ws': '<product><productIdentifier>20</productIdentifier></product>',
    '/vendor/2/product.ws?identifier=20&pageIndex=1&pageSize=100': `<listResponse count="5">
      <instance id="1" identifier="20" type="BASE" name="Base"/>
      <instance id="2" identifier="20" type="MODIFICATION" name="Update" deployed="false" lifeCycleStage="Commit" descr="A"/>
      <instance id="3" identifier="20" type="MODIFICATION" name="Other base"/>
      <instance id="4" identifier="20" type="CANCELLATION" name="Cancel"/>
      <instance id="5" identifier="21" type="MODIFICATION" name="Different identifier"/>
    </listResponse>`,
    '/product/2.ws': '<product><baseProductId>1</baseProductId></product>',
    '/product/3.ws': '<product><baseProductId>9</baseProductId></product>',
  });
  assert.deepEqual(await client.listModificationProducts('1'), [{
    productId: '2', productName: 'Update', productIdentifier: '20',
    lifeCycleStage: 'Commit', deployed: 'false', description: 'A',
  }]);
});

test('paginates through all matching products', async () => {
  const entries = Array.from({ length: 100 }, (_, i) =>
    `<instance id="${i + 2}" identifier="20" type="BASE"/>`).join('');
  const client = clientWithResponses({
    '/product/1.ws': '<product><productIdentifier>20</productIdentifier></product>',
    '/vendor/2/product.ws?identifier=20&pageIndex=1&pageSize=100': `<listResponse count="100">${entries}</listResponse>`,
    '/vendor/2/product.ws?identifier=20&pageIndex=2&pageSize=100': '<listResponse count="1"><instance id="102" identifier="20" type="MODIFICATION" name="Last"/></listResponse>',
    '/product/102.ws': '<product><baseProductId>1</baseProductId></product>',
  });
  const results = await client.listModificationProducts(1);
  assert.equal(results.length, 1);
  assert.equal(results[0].productId, '102');
});

test('rejects invalid EMS data and identifies expired sessions', async () => {
  await assert.rejects(() => clientWithResponses({}).listModificationProducts('../1'), /positive number/);
  await assert.rejects(() => clientWithResponses({
    '/product/1.ws': '<product><productIdentifier>20</productIdentifier></product>',
    '/vendor/2/product.ws?identifier=20&pageIndex=1&pageSize=100': '<invalid/>',
  }).listModificationProducts(1), /invalid product search/);
  const client = clientWithResponses({});
  client.call = async () => { const error = new Error('Redirect'); error.status = 302; throw error; };
  await assert.rejects(() => client.listModificationProducts(1), { status: 401 });
});

test('resolves base products by identifier, rejecting missing or ambiguous matches', async () => {
  const search = '/vendor/2/product.ws?identifier=12345&pageIndex=1&pageSize=100';
  const instance = '<instance id="60" identifier="12345" type="BASE" lifeCycleStage="Commit"/>';
  assert.equal((await clientWithResponses({
    [search]: `<listResponse>${instance}<instance id="61" identifier="12345" type="MODIFICATION"/></listResponse>`,
  }).findBaseProductByIdentifier('12345')).id, '60');
  for (const response of ['<listResponse count="0"/>', `<listResponse>${instance}<instance id="62" identifier="12345" type="BASE"/></listResponse>`]) {
    await assert.rejects(() => clientWithResponses({ [search]: response }).findBaseProductByIdentifier('12345'), /Expected one base product/);
  }
});

function catalogApp(fetch) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'catalog.html'), 'utf8');
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  let definition;
  vm.runInNewContext(script, {
    fetch,
    Vue: { createApp: (options) => { definition = options; return { mount() {} }; } },
  });
  const app = { ...definition.methods };
  Object.assign(app, definition.data.call(app));
  return app;
}

test('selection ignores stale modification requests', async () => {
  const requests = [];
  const app = catalogApp((url) => new Promise((resolve) => requests.push({ url, resolve })));
  app.selectItem({ productId: 1 });
  app.selectItem({ productId: 2 });
  assert.equal(requests[0].url, '/api/catalog/products/1/modifications');
  requests[1].resolve({ ok: true, json: async () => [{ productId: 'new' }] });
  await new Promise(setImmediate);
  requests[0].resolve({ ok: true, json: async () => [{ productId: 'old' }] });
  await new Promise(setImmediate);
  assert.equal(app.modifications[0].productId, 'new');
  assert.equal(app.modificationsLoading, false);
});

test('modification errors are shown and retry reloads data', async () => {
  let attempt = 0;
  const app = catalogApp(async () => ++attempt === 1
    ? { ok: false, statusText: 'Bad gateway', json: async () => ({ error: 'EMS unavailable' }) }
    : { ok: true, json: async () => [] });
  const product = { productId: 1 };
  await app.loadModifications(product);
  assert.match(app.modificationsError, /EMS unavailable/);
  await app.loadModifications(product);
  assert.equal(app.modificationsError, '');
  assert.equal(app.modifications.length, 0);
});
