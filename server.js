const fs = require('fs');
const path = require('path');
const express = require('express');
const { EmsClient } = require('./ems-client');
const { ActClient } = require('./act-client');

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

app.post('/api/entitlements', express.json(), async (req, res) => {
  const {
    customerId,
    productId,
    enforcementId,
    startDate,
    endDate,
    neverExpires,
    numberOfKeys,
    activationsPerKey,
    numberOfUpdates,
    haspIds,
    lineItemType,
    description,
    refId1,
    refId2,
  } = req.body || {};
  const isDate = (value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  const isPositiveInteger = (value) => /^\d+$/.test(String(value)) && Number(value) > 0 && Number(value) <= 999999;
  const isId = (value) => /^\d+$/.test(String(value || '')) && Number(value) > 0;

  if (!isId(customerId) || !isId(productId) || !isId(enforcementId)) {
    return res.status(400).json({ error: 'Select a customer and enter numeric product and enforcement IDs' });
  }
  if (typeof neverExpires !== 'boolean' ||
      !isDate(startDate) || (!neverExpires && !isDate(endDate)) ||
      (!neverExpires && endDate < startDate)) {
    return res.status(400).json({ error: 'Enter a valid start date and an end date on or after it' });
  }
  const validLineItemTypes = new Set(['Hardware_Key', 'Product_Key', 'ProtectionKey_Update']);
  if (!validLineItemTypes.has(lineItemType)) {
    return res.status(400).json({ error: 'Unsupported line item type' });
  }
  if (lineItemType === 'Product_Key' &&
      (!isPositiveInteger(numberOfKeys) || !isPositiveInteger(activationsPerKey))) {
    return res.status(400).json({ error: 'Number of product keys and activations per key must be between 1 and 999999' });
  }
  if (lineItemType === 'Hardware_Key' && !isPositiveInteger(activationsPerKey)) {
    return res.status(400).json({ error: 'Number of keys must be between 1 and 999999' });
  }
  if (lineItemType === 'ProtectionKey_Update' &&
      (!isPositiveInteger(numberOfUpdates) ||
       !Array.isArray(haspIds) ||
       haspIds.length === 0 ||
       haspIds.length > 100 ||
       haspIds.some((id) => typeof id !== 'string' || !id.trim() || id.length > 250))) {
    return res.status(400).json({ error: 'Enter 1 to 100 protection key IDs (250 characters each maximum) and a valid number of updates' });
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

    if (!ems.authenticated) await ems.authenticate();
    const vendorId = process.env.EMS_VENDOR_ID || '2';
    const result = await ems.createEntitlement({
      customerId: selectedCustomer.customerId ?? selectedCustomer.id,
      productId,
      enforcementId,
      vendorId,
      startDate,
      endDate: neverExpires ? '2500-12-31' : endDate,
      numberOfKeys,
      activationsPerKey,
      numberOfUpdates,
      haspIds,
      lineItemType,
      description,
      refId1,
      refId2,
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

app.post('/api/act/companies/:id/add-to-ems', async (req, res) => {
  if (!act.token) return res.status(401).json({ error: 'Log in to Act! first' });
  try {
    const company = await act.getCompany(req.params.id);
    if (!company || typeof company.name !== 'string' || !company.name.trim()) {
      return res.status(502).json({ error: 'Act! returned a company without a name' });
    }

    const reference = String(company.id || req.params.id);
    const existing = await withSession(() => ems.listCustomers());
    if (existing.some((c) => String(c.refId1 ?? '').trim().toLowerCase() === reference.toLowerCase())) {
      return res.status(409).json({ error: 'This ACT company already exists in EMS' });
    }

    const location = await withSession(() => ems.createCustomer({
      name: company.name.trim(),
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

// Bound to localhost because the page exposes customer data without its own login.
app.listen(PORT, '127.0.0.1', () => console.log(`Open http://localhost:${PORT}`));
