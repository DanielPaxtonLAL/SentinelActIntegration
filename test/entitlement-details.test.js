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

test('labels entitlement types and allows filtering by key update', () => {
  const { typeLabel } = definition.methods;
  assert.equal(typeLabel(1), 'HL Key');
  assert.equal(typeLabel('2'), 'Product Key');
  assert.equal(typeLabel(3), 'Key Update');
  assert.equal(typeLabel(' 3 '), 'Key Update');
  assert.equal(typeLabel(4), 4);
  const app = { filter: 'key update', entitlements: [{ id: '1', type: 3 }, { id: '2', type: 2 }], typeLabel };
  assert.equal(definition.computed.filteredEntitlements.call(app)[0].id, '1');
  assert.equal(definition.computed.filteredEntitlements.call(app).length, 1);
});

test('shows entitlement dates in local time with date-only values unchanged', () => {
  const { formatLocalDate, displayValue } = definition.methods;
  const dateTime = '2026-11-12T09:00:00+13:00';
  const localDate = new Date(dateTime);
  const expectedLocal = `${String(localDate.getDate()).padStart(2, '0')}-${String(localDate.getMonth() + 1).padStart(2, '0')}-${localDate.getFullYear()}`;
  assert.equal(formatLocalDate.call({ displayValue }, dateTime), expectedLocal);
  assert.equal(formatLocalDate.call({ displayValue }, '2026-11-12T09:00:00'), expectedLocal);
  assert.equal(formatLocalDate.call({ displayValue }, '2026-11-12'), '12-11-2026');
  assert.equal(formatLocalDate.call({ displayValue }, null), '—');
  assert.match(html, /<th>Created Date<\/th>/);
  assert.match(html, /:title="entitlement\.createDate \? 'UTC, DD-MM-YYYY' : null"[^>]*>[\s\S]*?highlightParts\(formatUtcDate\(entitlement\.createDate\)\)/);
  assert.ok(html.includes('Created Date</div><div class="detail-value" role="cell" :title="selectedEntitlement.createDate ? \'UTC, DD-MM-YYYY\' : null">{{ formatUtcDate(selectedEntitlement.createDate) }}'));
  assert.ok(html.includes('Start Date</div><div class="detail-value" role="cell" :title="selectedEntitlement.startDate ? \'Local time, DD-MM-YYYY\' : null">{{ formatLocalDate(selectedEntitlement.startDate) }}'));
  assert.ok(html.includes('{{ formatEndDate(selectedEntitlement.endDate) }}'));
  assert.ok(html.includes(':title="/^\\d{4}-\\d{2}-\\d{2}$/.test(selectedExpiryDate) ? \'Local time, DD-MM-YYYY\' : null">{{ formatLocalDate(selectedExpiryDate) }}'));
  const app = { displayValue, formatLocalDate };
  assert.equal(definition.methods.formatUtcDate.call(app, '2026-11-12T09:00:00+13:00'), '11-11-2026');
  assert.equal(definition.methods.formatUtcDate.call(app, '2026-11-12'), '12-11-2026');
  assert.equal(definition.methods.formatEndDate.call(app, '2500-12-31'), 'Never');
  assert.equal(definition.methods.formatEndDate.call(app, '2500-12-30'), '30-12-2500');
  assert.equal(definition.methods.formatEndDate.call(app, null), '—');
  assert.equal(formatLocalDate.call(app, '2024-02-29'), '29-02-2024');
  assert.equal(formatLocalDate.call(app, 'N/A (Not Lease)'), 'N/A (Not Lease)');
  assert.equal(formatLocalDate.call(app, 'Unavailable'), 'Unavailable');
});

test('shows customer, serial number, and expiry date in order in entitlement details', () => {
  assert.match(html, /<th>Irricad Order Code \(Ref ID 1\)<\/th>/);
  const details = html.match(/<div class="entitlement-detail-fields"[^>]*>([\s\S]*?)<\/div>\s*<p class="detail-footnote"/)[1];
  const labels = [...details.matchAll(/<div class="detail-label" role="rowheader"[^>]*>(.*?)<\/div>/g)].map((match) => match[1]);
  const checkboxes = details.match(/<input type="checkbox"/g) || [];
  assert.equal(checkboxes.length, labels.length);
  assert.doesNotMatch(details, /v-model|@change|@click/);
  assert.deepEqual(labels, ['Customer', 'Serial Number*', 'Irricad Order Code (Ref ID 1)', 'Created Date', 'Start Date', 'End Date', 'Standalone Irricad', 'Link Irricad', 'Pivot Irricad', 'Lease Irricad', 'Lease Expiry Date*', 'Irricad Version*']);
  assert.match(details, /Irricad Order Code \(Ref ID 1\)<\/div><div class="detail-value" role="cell">\{\{ displayValue\(selectedEntitlement\.refId1\) \}\}/);
  const app = { selectedEntitlement: {
    baseProductId: '6047',
    leaseProductId: '6050',
    products: [
      { productId: '6047', memorySegments: [
        { name: 'Serial Number', saot: true, text: '344432' },
        { name: 'Expiry Date', saot: true, text: '35383544' },
      ] },
      { productId: '6050', memorySegments: [] },
    ],
  } };
  Object.defineProperty(app, 'baseMemorySegments', {
    get: () => definition.computed.baseMemorySegments.call(app),
  });
  assert.equal(definition.computed.selectedSerialNumber.call(app), '01234');
  assert.equal(definition.computed.selectedExpiryDate.call(app), '2024-02-29');
  app.selectedEntitlement.products[0].memorySegments[1].text = '585D';
  assert.equal(definition.computed.selectedExpiryDate.call(app), '2024-02-29');
  app.selectedEntitlement.products[0].memorySegments[1].text = '0000585D';
  assert.equal(definition.computed.selectedExpiryDate.call(app), '2024-02-29');
  app.selectedEntitlement.products[0].memorySegments[1].text = '35383544';
  app.selectedEntitlement.products.pop();
  assert.equal(definition.computed.selectedExpiryDate.call(app), 'N/A (Not Lease)');
  app.selectedEntitlement.products[0].memorySegments = [];
  assert.equal(definition.computed.selectedSerialNumber.call(app), 'Unavailable');
  app.selectedEntitlement.products.push({ productId: '6050', memorySegments: [] });
  assert.equal(definition.computed.selectedExpiryDate.call(app), 'Unavailable');
});

test('marks malformed or invalid base expiry dates unavailable', () => {
  const app = {
    selectedEntitlement: { leaseProductId: '6050', products: [{ productId: '6050' }] },
    baseMemorySegments: [{ name: 'Expiry Date', saot: true, text: '30303030' }],
  };
  assert.equal(definition.computed.selectedExpiryDate.call(app), 'Unavailable');
  app.baseMemorySegments[0].text = '35383230';
  assert.equal(definition.computed.selectedExpiryDate.call(app), 'Unavailable');
});

test('shows each configured product alias as present or absent', () => {
  assert.match(html, /<div class="detail-value"[^>]*>\{\{ productPresent\('standalone'\) \}\}<\/div>/);
  const app = { selectedEntitlement: {
    products: [{ productId: '6048' }, { productId: '6052' }],
    productAliases: [
      { alias: 'standalone', id: '6048', group: 'product' },
      { alias: 'link', id: '6049', group: 'product' },
      { alias: 'v22', id: '', group: 'version' },
      { alias: 'v23', id: '6052', group: 'version' },
      { alias: 'lease', id: '6050', group: 'lease' },
    ],
  } };
  assert.deepEqual(
    definition.computed.selectedProductAttributes.call(app).map(({ alias, present }) => ({ alias, present })),
    [
      { alias: 'standalone', present: true },
      { alias: 'link', present: false },
      { alias: 'lease', present: false },
    ]
  );
  assert.ok(!html.includes('>End date<'));
});

test('shows the decoded base product version in entitlement details', () => {
  assert.match(html, /<div class="detail-label"[^>]*>Irricad Version\*<\/div><div class="detail-value"[^>]*>\{\{ decodedVersion \}\}<\/div>/);
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
