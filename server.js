const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const { EmsClient } = require('./ems-client');
const { ActClient } = require('./act-client');
const { validateMemoryValues } = require('./entitlement-memory');

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
const COMPLETE_PRODUCT_LIFECYCLE_STAGE = '2';
const SENTINEL_LDK_ENFORCEMENT_ID = '1';

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
});

// Runs an EMS call, logging in first and once more if the session has expired.
async function withSession(fn) {
  if (!ems.authenticated) await ems.authenticate();
  try {
    return await fn();
  } catch (err) {
    if (err.status === 401) {
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

app.use(express.static(publicDir));

app.get('/api/customers', async (req, res) => {
  try {
    res.json(await withSession(() => ems.listCustomers()));
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
    res.json(await withSession(() => ems.getEntitlementDetails(req.params.id)));
  } catch (err) {
    if (err.status === 401) {
      ems.authenticated = false;
      ems.cookies.clear();
    }
    console.error(err.message);
    res.status(502).json({ error: err.message });
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

app.post('/api/entitlements', express.json(), async (req, res) => {
  const {
    customerId,
    productIds,
    description,
    refId1 = '',
    refId2 = '',
    memoryValues = [],
  } = req.body || {};
  const isId = (value) => /^\d+$/.test(String(value || '')) && Number(value) > 0;

  if (!isId(customerId) ||
      !Array.isArray(productIds) || productIds.length === 0 || productIds.length > 100 ||
      productIds.some((id) => !isId(id)) ||
      new Set(productIds.map(String)).size !== productIds.length) {
    return res.status(400).json({ error: 'Select a customer and add 1 to 100 unique EMS products' });
  }
  if (typeof description !== 'string' || description.length > 510 ||
      typeof refId1 !== 'string' || refId1.length > 250 ||
      typeof refId2 !== 'string' || refId2.length > 250) {
    return res.status(400).json({ error: 'Description must be 510 characters or fewer; reference IDs must be 250 characters or fewer' });
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
    const products = await withSession(() => ems.listCatalog('products', vendorId));
    const availableProductIds = new Set(products
      .filter((product) => String(product.lifeCycleStage) === COMPLETE_PRODUCT_LIFECYCLE_STAGE)
      .map((product) => String(product.productId)));
    if (productIds.some((id) => !availableProductIds.has(String(id)))) {
      return res.status(400).json({ error: 'One or more selected products are not complete in EMS. Choose complete products and try again.' });
    }
    const enforcements = await withSession(() => ems.listEnforcements(vendorId));
    if (!enforcements.some((enforcement) => String(enforcement.id) === SENTINEL_LDK_ENFORCEMENT_ID)) {
      return res.status(400).json({ error: 'Sentinel LDK enforcement (1) is not available in EMS.' });
    }
    const productFiles = Object.fromEntries(await Promise.all(productIds.map(async (productId) => [
      String(productId),
      await withSession(() => ems.getProductReadOnlyMemory(productId)),
    ])));
    const memorySegments = validateMemoryValues(productIds, productFiles, memoryValues);

    const today = new Date();
    const startDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const result = await ems.createEntitlement({
      customerId: selectedCustomer.customerId ?? selectedCustomer.id,
      productIds,
      enforcementId: SENTINEL_LDK_ENFORCEMENT_ID,
      vendorId,
      startDate,
      endDate: '2500-12-31',
      numberOfKeys: 1,
      activationsPerKey: 1,
      lineItemType: 'Product_Key',
      description,
      refId1,
      refId2,
      memorySegments,
    });
    res.status(201).json(result);
  } catch (err) {
    if (err.status === 401) {
      ems.authenticated = false;
      ems.cookies.clear();
    }
    console.error(err.message);
    res.status(err.status === 400 ? 400 : 502).json({ error: err.message });
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
      emsName = `${parent.name.trim()} ${company.name.trim()}`;
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Local: http://localhost:${PORT}`);
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((network) => network && network.family === 'IPv4' && !network.internal)
    .map((network) => `http://${network.address}:${PORT}`);
  for (const address of addresses) console.log(`Network: ${address}`);
  console.log('Press Ctrl+C to stop the server.');
});
