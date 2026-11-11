const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'entitlements.html'), 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
let definition;
let fetchMemory;
vm.runInNewContext(script, {
  fetch: (...args) => fetchMemory(...args),
  Vue: { createApp: (options) => { definition = options; return { mount() {} }; } },
});

function versionFor(products, baseProductId = '6047') {
  const app = { selectedEntitlement: { products, baseProductId } };
  Object.defineProperty(app, 'baseMemorySegments', {
    get: () => definition.computed.baseMemorySegments.call(app),
  });
  return definition.computed.decodedVersion.call(app);
}

test('shows the decoded base product version in entitlement details', () => {
  assert.match(html, /<dt>Version<\/dt><dd>\{\{ decodedVersion \}\}<\/dd>/);
  const products = [
    { productId: '6048', memorySegments: [{ name: 'Version', text: '30303030' }] },
    { productId: '6047', memorySegments: [{ name: ' Version ', text: '45423544' }] },
  ];
  assert.equal(versionFor(products), 'v22');
  products[1].memorySegments[0].text = '45373735';
  assert.equal(versionFor(products), 'v23');
  products[1].memorySegments[0].text = '42454144';
  assert.equal(versionFor(products), 'v0');
  products[1].memorySegments[0].text = '45353435';
  assert.equal(versionFor(products), 'v23.528');
});

test('distinguishes missing and invalid version memory', () => {
  assert.equal(versionFor([]), 'Unavailable');
  assert.equal(versionFor([{ productId: '6047', memorySegments: [] }]), 'Unavailable');
  for (const text of ['', '0', '4542354Z', '47423544', '4542354441']) {
    assert.equal(versionFor([{ productId: '6047', memorySegments: [{ name: 'Version', text }] }]), 'Invalid version data');
  }
  assert.equal(versionFor([{ productId: '6047', memorySegments: [
    { name: 'Version', text: '45423544' },
    { name: 'version', text: '45423544' },
  ] }]), 'Invalid version data');
});

test('uses the selected version modification memory rather than the base default', async () => {
  const entitlement = {
    baseProductId: '6047',
    versionProductIds: ['6052'],
    products: [
      { productId: '6047', memorySegments: [{ name: 'Version', offset: 0, size: 4, text: '45423544' }] },
      { productId: '6052' },
    ],
  };
  fetchMemory = async (url) => {
    assert.equal(url, '/api/catalog/products/6052/read-only-memory');
    return { ok: true, json: async () => [{ kind: 'product', segments: [
      { offset: '0x0000', size: '4', content: '45373735', saot: false },
    ] }] };
  };
  const memory = await definition.methods.loadVersionMemory(entitlement);
  const app = { baseMemorySegments: entitlement.products[0].memorySegments, versionMemory: memory };
  assert.equal(definition.computed.decodedVersion.call(app), 'v23');
  entitlement.products.pop();
  assert.equal(await definition.methods.loadVersionMemory(entitlement), undefined);
  app.versionMemory = null;
  assert.equal(definition.computed.decodedVersion.call(app), 'v22');
});

test('refuses ambiguous, incomplete, editable or unavailable version writes', async () => {
  const entitlement = {
    baseProductId: '6047', versionProductIds: ['6052', '6053'],
    products: [
      { productId: '6047', memorySegments: [{ name: 'Version', offset: 0, size: 4, text: '45423544' }] },
      { productId: '6052' },
    ],
  };
  const segment = { offset: '0x0000', size: '4', content: '45373735', saot: false };
  for (const writes of [[], [segment, segment], [{ ...segment, size: 2 }], [{ ...segment, saot: true }]]) {
    fetchMemory = async () => ({ ok: true, json: async () => [{ kind: 'product', segments: writes }] });
    await assert.rejects(() => definition.methods.loadVersionMemory(entitlement), /one complete fixed Version write/);
  }
  fetchMemory = async () => ({ ok: false, statusText: 'Service unavailable', json: async () => ({ error: 'EMS error' }) });
  await assert.rejects(() => definition.methods.loadVersionMemory(entitlement), /EMS error/);
  entitlement.products.push({ productId: '6053' });
  await assert.rejects(() => definition.methods.loadVersionMemory(entitlement), /multiple version products/);
});
