const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const { EmsClient } = require('./ems-client');
const { ActClient } = require('./act-client');
const { validateMemoryValues } = require('./entitlement-memory');
const { pageIncludes, renderPage } = require('./page-includes');
const { loadFormData } = require('./entitlement-form-data');
const LeaseDates = require('./public/lease-dates');

const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    process.env[m[1]] ??= m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const { EMS_URL, EMS_USER, EMS_PASS, EMS_INSECURE, EMS_API_VERSION, EMS_USER_TYPE } = process.env;
const PORT = process.env.PORT || 3000;
const SENTINEL_LDK_ENFORCEMENT_ID = '1';
// Product IDs and form labels live in entitlement-form-data.json (or the file named by EMS_FORM_DATA).
const formData = loadFormData(path.resolve(__dirname, process.env.EMS_FORM_DATA || 'entitlement-form-data.json'));

function formatLocalDateTime(date) {
  const pad = (value, length = 2) => String(value).padStart(length, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const offsetHours = Math.floor(Math.abs(offset) / 60);
  const offsetMinutes = Math.abs(offset) % 60;
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(offsetHours)}:${pad(offsetMinutes)}`;
}

async function getEntitlementProducts() {
  const vendorId = process.env.EMS_VENDOR_ID || '2';
  const baseId = formData.baseProductId;
  const base = await withSession(() => ems.getProductSummary(baseId));
  if (String(base.lifeCycleStage).toLowerCase() !== 'commit' ||
      String(base.enforcementProductType).toUpperCase() !== 'BASE') {
    throw new Error(`Base product ${baseId} is not a complete base product in EMS (check entitlement-form-data.json)`);
  }
  const modifications = await withSession(() => ems.listModificationProducts(baseId, vendorId));
  const complete = modifications.filter((product) => String(product.lifeCycleStage).toLowerCase() === 'commit');
  const isAvailable = (id) => complete.some((product) => String(product.productId) === id);
  for (const required of formData.accessProducts) {
    if (!isAvailable(required.id)) {
      throw new Error(`Required product ${required.id} (${required.label}) is not a complete modification of base product ${baseId} in EMS (check entitlement-form-data.json)`);
    }
  }
  const withAvailability = (products, extra = {}) => products.map((option) => ({
    id: option.id,
    label: option.label,
    ...extra,
    available: isAvailable(option.id),
  }));
  return {
    baseProductId: baseId,
    modifications: complete,
    accessProducts: formData.accessProducts.map(({ id, label }) => ({ id, label })),
    optionalProducts: [
      ...withAvailability(formData.optionalProducts),
      ...withAvailability([formData.lease], { lease: true }),
    ],
    versionProducts: withAvailability(formData.versionProducts),
    defaultVersionLabel: formData.defaultVersionLabel,
    leaseExpiryRange: formData.leaseExpiryRange,
  };
}

if (!EMS_URL || !EMS_USER || !EMS_PASS) {
  console.error('Set EMS_URL, EMS_USER and EMS_PASS in .env');
  process.exit(1);
}

const ems = new EmsClient({
  baseUrl: EMS_URL,
  username: EMS_USER,
  password: EMS_PASS,
  insecure: EMS_INSECURE === '1',
  apiVersion: EMS_API_VERSION || 'v90',
  userType: EMS_USER_TYPE || 'ISV',
  serialNumberCustomerId: formData.highestProductKeySerialNumberCustomerId,
});

// Runs an EMS call, logging in first and once more if the session has expired.
async function withSession(fn) {
  if (!ems.authenticated) await ems.authenticate();
  try {
    return await fn();
  } catch (err) {
    if (err.status === 401 && !err.outcomeUnknown) {
      ems.authenticated = false;
      ems.cookies.clear();
      await ems.authenticate();
      return fn();
    }
    throw err;
  }
}

const app = express();
const publicDir = path.join(__dirname, 'public');
const reloadClients = new Set();

app.get('/__dev/reload', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  reloadClients.add(res);
  req.on('close', () => reloadClients.delete(res));
});

fs.watch(publicDir, (eventType, filename) => {
  if (!filename || path.extname(filename.toString()).toLowerCase() !== '.html') return;
  for (const client of reloadClients) client.write('event: reload\ndata: update\n\n');
});

app.use(pageIncludes(publicDir, path.join(__dirname, 'partials')));
app.use(express.static(publicDir));

app.get('/api/customers', async (req, res) => {
  try {
    res.json(await withSession(() => ems.listCustomers()));
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/product-key-serial-number', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const largest = await withSession(() => ems.getLargestProductKeySerial());
    res.json({ largest });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/entitlements', async (req, res) => {
  try {
    res.json(await withSession(() => ems.listEntitlements()));
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/enforcements', async (req, res) => {
  try {
    res.json(await withSession(() =>
      ems.listEnforcements(process.env.EMS_VENDOR_ID || '2')
    ));
  } catch (err) {
    if (err.status === 401) {
      ems.authenticated = false;
      ems.cookies.clear();
    }
    console.error(err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/entitlements/:id', async (req, res) => {
  if (!/^[1-9]\d*$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Entitlement ID must be a positive number' });
  }
  try {
    const details = await withSession(() => ems.getEntitlementDetails(req.params.id));
    res.json({
      ...details,
      baseProductId: formData.baseProductId,
      versionProductIds: formData.versionProducts.map((product) => product.id),
      leaseProductId: formData.lease.id,
      productAliases: formData.productAliases,
    });
  } catch (err) {
    if (err.status === 401) {
      ems.authenticated = false;
      ems.cookies.clear();
    }
    console.error(err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/entitlements/:id/product-keys', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!/^[1-9]\d*$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Entitlement ID must be a positive number' });
  }
  try {
    res.json(await withSession(() => ems.getEntitlementProductKeys(req.params.id)));
  } catch (err) {
    console.error(err.message);
    res.status(err.status === 400 ? 400 : 502).json({ error: err.message });
  }
});

app.get('/api/catalog/:category', async (req, res) => {
  const categories = new Set(['products', 'features', 'dynamicMemory']);
  if (!categories.has(req.params.category)) {
    return res.status(404).json({ error: 'Unknown catalog category' });
  }
  try {
    res.json(await withSession(() =>
      ems.listCatalog(req.params.category, process.env.EMS_VENDOR_ID || '2')
    ));
  } catch (err) {
    if (err.status === 401) {
      ems.authenticated = false;
      ems.cookies.clear();
    }
    console.error(err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/catalog/products/:id/read-only-memory', async (req, res) => {
  if (!/^[1-9]\d*$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Product ID must be a positive number' });
  }
  try {
    res.json(await withSession(() => ems.getProductReadOnlyMemory(req.params.id)));
  } catch (err) {
    if (err.status === 401) {
      ems.authenticated = false;
      ems.cookies.clear();
    }
    console.error(err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/catalog/products/:id/modifications', async (req, res) => {
  if (!/^[1-9]\d*$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Product ID must be a positive number' });
  }
  try {
    res.json(await withSession(() =>
      ems.listModificationProducts(req.params.id, process.env.EMS_VENDOR_ID || '2')
    ));
  } catch (err) {
    if (err.status === 401) {
      ems.authenticated = false;
      ems.cookies.clear();
    }
    console.error(err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/entitlement-products', async (req, res) => {
  try {
    res.json(await getEntitlementProducts());
  } catch (err) {
    if (err.status === 401) {
      ems.authenticated = false;
      ems.cookies.clear();
    }
    console.error(err.message);
    res.status(502).json({ error: err.message });
  }
});

const saveEntitlement = async (req, res) => {
  const existingId = req.params?.id;
  if (existingId !== undefined && !/^[1-9]\d*$/.test(existingId)) {
    return res.status(400).json({ error: 'Entitlement ID must be a positive number' });
  }
  const {
    customerId,
    productIds,
    description,
    refId1,
    refId2 = '',
    memoryValues = [],
    startDate: requestedStartDate,
  } = req.body || {};
  const isId = (value) => /^\d+$/.test(String(value || '')) && Number(value) > 0;
  const isCalendarDate = (value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };

  if (!isId(customerId) ||
      !Array.isArray(productIds) || productIds.length > 99 ||
      productIds.some((id) => !isId(id)) ||
      new Set(productIds.map(String)).size !== productIds.length) {
    return res.status(400).json({ error: 'Select a customer and up to 99 unique modification products' });
  }
  if (requestedStartDate !== undefined && !isCalendarDate(requestedStartDate)) {
    return res.status(400).json({ error: 'Start date must be a valid calendar date in YYYY-MM-DD format.' });
  }
  if (typeof description !== 'string' || description.length > 510 ||
      (refId1 !== undefined && (typeof refId1 !== 'string' || refId1.length > 250)) ||
      typeof refId2 !== 'string' || refId2.length > 250) {
    return res.status(400).json({ error: 'Description must be 510 characters or fewer; reference IDs must be 250 characters or fewer' });
  }
  if (!existingId && (typeof refId1 !== 'string' || !refId1.trim())) {
    return res.status(400).json({ error: 'Irricad Order Code (refID 1) is required.' });
  }

  try {
    const customers = await withSession(() => ems.listCustomers());
    const selectedCustomerId = String(customerId).trim();
    const selectedCustomer = customers.find((customer) =>
      [customer.customerId, customer.id].some((id) => String(id ?? '').trim() === selectedCustomerId)
    );
    if (!selectedCustomer) {
      return res.status(400).json({ error: 'The selected customer is no longer in the EMS customer list. Reload customers and try again.' });
    }

    const vendorId = process.env.EMS_VENDOR_ID || '2';
    const { baseProductId, modifications, optionalProducts, versionProducts } = await getEntitlementProducts();
    const availableProductIds = new Set(modifications.map((product) => String(product.productId)));
    if (productIds.some((id) => !availableProductIds.has(String(id)) ||
        [...optionalProducts, ...versionProducts].some((product) => product.id === String(id) && !product.available))) {
      return res.status(400).json({ error: 'One or more selected products are not complete modifications of the required base product.' });
    }
    if (productIds.filter((id) => versionProducts.some((product) => product.id === String(id))).length > 1) {
      return res.status(400).json({ error: 'Select at most one version.' });
    }
    if (!formData.accessProducts.some((product) => productIds.map(String).includes(product.id))) {
      return res.status(400).json({ error: `Select at least one of: ${formData.accessProducts.map((product) => product.label).join(', ')}.` });
    }
    const allProductIds = [baseProductId, ...productIds.map(String)];
    const enforcements = await withSession(() => ems.listEnforcements(vendorId));
    if (!enforcements.some((enforcement) => String(enforcement.id) === SENTINEL_LDK_ENFORCEMENT_ID)) {
      return res.status(400).json({ error: 'Sentinel LDK enforcement (1) is not available in EMS.' });
    }
    const productFiles = Object.fromEntries(await Promise.all(allProductIds.map(async (productId) => [
      String(productId),
      await withSession(() => ems.getProductReadOnlyMemory(productId)),
    ])));
    if (!Array.isArray(memoryValues)) {
      return res.status(400).json({ error: 'Memory segment values must be a list.' });
    }
    const expirySegments = productFiles[baseProductId]
      .filter((file) => file.kind === 'product')
      .flatMap((file) => file.segments)
      .filter((segment) => segment.saot && typeof segment.name === 'string' &&
        segment.name.trim().toLowerCase() === 'expiry date');
    const leaseSelected = productIds.map(String).includes(formData.lease.id);
    if (expirySegments.length > 1 || (leaseSelected && expirySegments.length !== 1)) {
      return res.status(400).json({ error: 'EMS must provide exactly one editable base product Expiry Date segment for Lease.' });
    }
    let resolvedMemoryValues = memoryValues;
    if (expirySegments.length && !leaseSelected) {
      const expiry = expirySegments[0];
      resolvedMemoryValues = memoryValues.filter((value) =>
        !value || String(value.productId) !== baseProductId || String(value.segmentId) !== String(expiry.id)
      );
      resolvedMemoryValues.push({ productId: baseProductId, segmentId: expiry.id, content: expiry.content });
    }
    const memorySegments = validateMemoryValues(allProductIds, productFiles, resolvedMemoryValues);

    if (!existingId) {
      const serialSegments = productFiles[baseProductId]
        .filter((file) => file.kind === 'product')
        .flatMap((file) => file.segments)
        .filter((segment) => segment.saot && typeof segment.name === 'string' &&
          segment.name.trim().toLowerCase() === 'serial number');
      if (serialSegments.length !== 1 || Number(serialSegments[0].size) !== 4) {
        return res.status(400).json({ error: 'EMS must provide exactly one editable 4-byte base product Serial Number segment.' });
      }
      const serial = memorySegments.find((segment) => segment.id === String(serialSegments[0].id));
      const digits = Buffer.from(serial.content, 'hex').toString('latin1');
      if (!/^[0-9a-f]{4}$/i.test(digits)) {
        return res.status(400).json({ error: 'The serial number segment must contain four ASCII hexadecimal digits.' });
      }
    }

    let existing = null;
    if (existingId) {
      existing = await withSession(() => ems.getEntitlementDetails(existingId));
      if (String(existing.entState).toUpperCase() !== 'DRAFT') {
        return res.status(400).json({ error: 'Only draft entitlements can be edited.' });
      }
    }
    const today = new Date();
    const startDate = existing?.startDate ?? requestedStartDate ?? `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    if (leaseSelected) {
      const localToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      const expiry = memorySegments.find((segment) => segment.id === String(expirySegments[0].id));
      try {
        LeaseDates.validate(LeaseDates.decode(expiry.content), String(startDate).slice(0, 10), localToday, formData.leaseExpiryRange);
      } catch (err) {
        return res.status(400).json({ error: `Invalid lease expiry date: ${err.message}` });
      }
    }
    const entitlementData = {
      customerId: selectedCustomer.customerId ?? selectedCustomer.id,
      productIds: allProductIds,
      enforcementId: SENTINEL_LDK_ENFORCEMENT_ID,
      vendorId,
      startDate,
      createDate: existing ? undefined : formatLocalDateTime(today),
      endDate: existing?.endDate ?? '2500-12-31',
      eid: existing?.eid,
      numberOfKeys: 1,
      activationsPerKey: 1,
      lineItemType: 'Product_Key',
      description,
      refId1: refId1 ?? String(existing?.refId1 ?? ''),
      refId2,
      memorySegments,
    };
    if (existingId) {
      const result = await ems.updateEntitlement(existingId, entitlementData);
      return res.status(200).json(result);
    }
    return res.status(201).json(await ems.createEntitlement(entitlementData));
  } catch (err) {
    if (err.status === 401) {
      ems.authenticated = false;
      ems.cookies.clear();
    }
    console.error(err.message);
    res.status(err.status === 400 ? 400 : 502).json({ error: err.message });
  }
};
app.post('/api/entitlements', express.json(), saveEntitlement);
app.put('/api/entitlements/:id', express.json(), saveEntitlement);
app.post('/api/entitlements/:id/produce', async (req, res) => {
  if (!/^[1-9]\d*$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Entitlement ID must be a positive number.' });
  }
  try {
    res.json(await withSession(() => ems.produceEntitlement(req.params.id)));
  } catch (err) {
    console.error(err.message);
    res.status(err.status === 400 ? 400 : 502).json({ error: err.message, outcomeUnknown: Boolean(err.outcomeUnknown) });
  }
});
app.delete('/api/entitlements/:id', async (req, res) => {
  if (!/^[1-9]\d*$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Entitlement ID must be a positive number' });
  }
  try {
    res.json(await withSession(() => ems.deleteEntitlement(req.params.id)));
  } catch (err) {
    if (err.status === 401) {
      ems.authenticated = false;
      ems.cookies.clear();
    }
    console.error(err.message);
    res.status(502).json({ error: err.message });
  }
});

const { ACT_URL, ACT_DATABASE } = process.env;
const act = new ActClient({
  baseUrl: ACT_URL || 'http://VLALACT2/Act.Web.API',
  database: ACT_DATABASE || 'Irricad',
});

app.post('/api/act/login', express.json(), async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  try {
    await act.authenticate(username, password);
    res.json({ ok: true });
  } catch (err) {
    act.token = null;
    console.error(err.message);
    res.status(err.status === 401 ? 401 : 502).json({ error: err.message });
  }
});

app.post('/api/act/logout', (req, res) => {
  act.token = null;
  res.json({ ok: true });
});

app.get('/api/act/session', (req, res) => {
  res.json({ authenticated: Boolean(act.token) });
});

app.get('/api/act/companies', async (req, res) => {
  if (!act.token) return res.status(401).json({ error: 'Log in to Act! first' });
  try {
    res.json(await act.listCompanies());
  } catch (err) {
    if (err.status === 401) act.token = null;
    console.error(err.message);
    res.status(err.status === 401 ? 401 : 502).json({ error: err.status === 401 ? 'Act! session expired, log in again' : err.message });
  }
});

app.get('/api/act/companies/:id/divisions', async (req, res) => {
  if (!act.token) return res.status(401).json({ error: 'Log in to Act! first' });
  try {
    res.json(await act.getCompanyDivisions(req.params.id));
  } catch (err) {
    if (err.status === 401) act.token = null;
    console.error(err.message);
    res.status(err.status === 401 ? 401 : 502).json({
      error: err.status === 401 ? 'Act! session expired, log in again' : err.message,
    });
  }
});

app.post('/api/act/companies/:id/add-to-ems', express.json(), async (req, res) => {
  if (!act.token) return res.status(401).json({ error: 'Log in to Act! first' });
  try {
    const company = await act.getCompany(req.params.id);
    if (!company || typeof company.name !== 'string' || !company.name.trim()) {
      return res.status(502).json({ error: 'Act! returned a company without a name' });
    }
    const divisions = company.hasDivisions === true ? [] : await act.getCompanyDivisions(req.params.id);
    if (!Array.isArray(divisions)) {
      throw new Error('Act! returned an invalid company divisions response');
    }
    if (company.hasDivisions === true || divisions.length > 0) {
      return res.status(409).json({ error: 'Companies with divisions cannot be added to EMS; add a division instead' });
    }

    let emsName = company.name.trim();
    if (req.body && req.body.parentId) {
      const parentId = String(req.body.parentId);
      if (parentId === String(company.id || req.params.id)) {
        return res.status(400).json({ error: 'A company cannot be its own parent' });
      }
      const parentDivisions = await act.getCompanyDivisions(parentId);
      if (!Array.isArray(parentDivisions) ||
          !parentDivisions.some((division) =>
            division && String(division.id) === String(company.id || req.params.id)
          )) {
        return res.status(400).json({ error: 'The specified parent does not contain this ACT company' });
      }
      const parent = await act.getCompany(parentId);
      if (!parent || typeof parent.name !== 'string' || !parent.name.trim()) {
        return res.status(502).json({ error: 'Act! returned a parent company without a name' });
      }
      emsName = `${parent.name.trim()} - ${company.name.trim()}`;
    }

    const reference = String(company.id || req.params.id);
    const existing = await withSession(() => ems.listCustomers());
    if (existing.some((c) => String(c.refId1 ?? '').trim().toLowerCase() === reference.toLowerCase())) {
      return res.status(409).json({ error: 'This ACT company already exists in EMS' });
    }

    const location = await withSession(() => ems.createCustomer({
      name: emsName,
      reference,
      vendorId: process.env.EMS_VENDOR_ID || 2,
      phone: company.businessPhone || company.phone || '',
    }));
    res.status(201).json({ location });
  } catch (err) {
    if (err.status === 401) act.token = null;
    console.error(err.message);
    res.status(err.status === 401 ? 401 : 502).json({
      error: err.status === 401
        ? 'Act! session expired, log in again'
        : `${err.message}${err.body ? `: ${typeof err.body === 'string' ? err.body : JSON.stringify(err.body)}` : ''}`,
    });
  }
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(404).type('text').send('Not found');
  fs.readFile(path.join(publicDir, '404.html'), 'utf8', (err, html) => {
    if (err) return res.status(404).type('text').send('Page not found');
    res.status(404).type('html').send(renderPage(html, path.join(__dirname, 'partials'), '/404.html'));
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Local: http://localhost:${PORT}`);
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((network) => network && network.family === 'IPv4' && !network.internal)
    .map((network) => `http://${network.address}:${PORT}`);
  for (const address of addresses) console.log(`Network: ${address}`);
  console.log('Press Ctrl+C to stop the server.');
});
