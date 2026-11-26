const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const { EmsClient } = require('./ems-client');
const { ActClient } = require('./act-client');
const { createActSessions } = require('./act-sessions');
const { validateMemoryValues } = require('./entitlement-memory');
const { pageIncludes, renderPage } = require('./page-includes');
const { loadFormData } = require('./entitlement-form-data');
const { getEmsConfig } = require('./ems-config');
const { createProductKeySerials, decodeProductKeySerial, duplicateProductKeySerialError } = require('./product-key-serials');
const { loadEnvironmentFile } = require('./environment');
const { buildHistoryV2cp } = require('./v2cp-package');
const LeaseDates = require('../public/lease-dates');

const projectRoot = path.resolve(__dirname, '..');
const envFile = path.join(projectRoot, '.env');
loadEnvironmentFile(envFile, process.env, fs);

const { ACT_URL, ACT_DATABASE } = process.env;
const PORT = process.env.INTEGRATION_PORT || process.env.PORT || 3000;
const SENTINEL_LDK_ENFORCEMENT_ID = '1';
let emsConfig;
try {
  emsConfig = getEmsConfig(process.env, process.argv.slice(2));
  if (!ACT_URL) throw new Error('Set ACT_URL in .env.');
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const is_test_mode = emsConfig.isTestMode;
// Product IDs and form labels live in entitlement-form-data.json (or the file named by EMS_FORM_DATA).
const formData = loadFormData(path.resolve(projectRoot, process.env.EMS_FORM_DATA || 'entitlement-form-data.json'), is_test_mode);

/** Format the creation timestamp with the server's local UTC offset for EMS. */
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

/** Validate the selected base and access products and annotate optional product availability. */
async function getEntitlementProducts(ems) {
  const vendorId = process.env.EMS_VENDOR_ID || '2';
  const baseId = formData.baseProductId;
  const base = await withSession(ems, () => ems.getProductSummary(baseId));
  if (String(base.lifeCycleStage).toLowerCase() !== 'commit' ||
      String(base.enforcementProductType).toUpperCase() !== 'BASE') {
    throw new Error(`Base product ${baseId} is not a complete base product in EMS (check entitlement-form-data.json)`);
  }
  const modifications = await withSession(ems, () => ems.listModificationProducts(baseId, vendorId));
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

/** Invalidate a browser's EMS session if the upstream service reports it expired. */
async function withSession(ems, fn) {
  if (!ems.authenticated) {
    const error = new Error('EMS session expired. Log in again.');
    error.status = 401;
    throw error;
  }
  try {
    return await fn();
  } catch (err) {
    if (err.status === 401) {
      ems.authenticated = false;
      ems.cookies.clear();
    }
    throw err;
  }
}

// Start the Express app and wire up a lightweight live-reload mechanism for the front-end.
const app = express();
const publicDir = path.join(projectRoot, 'public');
const reloadClients = new Set();
const {
  withProductKeySerialLock,
  initializeNextProductKeySerial,
  advanceProductKeySerial,
  getUsedProductKeySerialNumbers,
} = createProductKeySerials({ baseProductId: formData.baseProductId, withSession });

async function ensureNextProductKeySerialInitialized(ems) {
  if (ems.nextProductKeySerialInitialized) return;
  await withProductKeySerialLock(async () => {
    if (ems.nextProductKeySerialInitialized) return;
    await initializeNextProductKeySerial(ems);
    ems.nextProductKeySerialInitialized = true;
  });
}

// SSE endpoint used by the browser to refresh static pages when HTML files change during development.
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

for (const [directory, extensions] of [[publicDir, ['.html', '.js']], [path.join(publicDir, 'pages'), ['.js']]]) {
  fs.watch(directory, (eventType, filename) => {
    if (!filename || !extensions.includes(path.extname(filename.toString()).toLowerCase())) return;
    for (const client of reloadClients) client.write('event: reload\ndata: update\n\n');
  });
}

const loginProgress = new Map();
const sessions = createActSessions(() => ({
  async authenticate(username, password, actUsername, actPassword, reportProgress = () => {}) {
    this.ems = new EmsClient({
      baseUrl: emsConfig.baseUrl,
      username,
      password,
      insecure: emsConfig.insecure,
      apiVersion: emsConfig.apiVersion,
      userType: emsConfig.userType,
      nextSerialNumberCustomerId: formData.nextProductKeySerialNumberCustomerId,
    });
    reportProgress('ems');
    try {
      await this.ems.authenticate();
    } catch (err) {
      const error = new Error('EMS authentication failed');
      error.service = 'EMS';
      error.status = err.status;
      throw error;
    } finally {
      this.ems.password = undefined;
    }
    this.act = new ActClient({
      baseUrl: ACT_URL,
      database: ACT_DATABASE || 'Irricad',
    });
    reportProgress('act');
    try {
      await this.act.authenticate(actUsername, actPassword);
    } catch (err) {
      const error = new Error('Act! authentication failed');
      error.service = 'Act!';
      error.status = err.status;
      throw error;
    }
  },
}));

app.use((req, res, next) => {
  const page = req.path.toLowerCase();
  if ((req.method === 'GET' || req.method === 'HEAD') &&
      !page.startsWith('/api/') &&
      (page === '/' || page.endsWith('.html')) &&
      page !== '/login.html' && page !== '/404.html' &&
      !sessions.get(req)?.ems.authenticated) {
    return res.redirect('/login.html');
  }
  next();
});
app.use(pageIncludes(publicDir, path.join(projectRoot, 'partials'), is_test_mode));
app.use(express.static(publicDir));
app.get('/vendor/forge.min.js', (req, res) => {
  res.sendFile(path.join(projectRoot, 'node_modules', 'node-forge', 'dist', 'forge.min.js'));
});

app.post('/api/login', express.json(), async (req, res) => {
  const { username, password, actUsername, actPassword, emsMode, progressId } = req.body || {};
  if (emsMode !== undefined && emsMode !== (is_test_mode ? 'test' : 'production')) {
    return res.status(409).json({ error: 'EMS server mode changed. Reload the login page and try again.' });
  }
  if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password ||
      typeof actUsername !== 'string' || !actUsername.trim() || typeof actPassword !== 'string' || !actPassword) {
    return res.status(400).json({ error: 'EMS and Act! usernames and passwords are required' });
  }
  if (progressId !== undefined && (typeof progressId !== 'string' || !/^[a-f0-9]{32}$/.test(progressId))) {
    return res.status(400).json({ error: 'Invalid login progress ID.' });
  }
  if (progressId && loginProgress.has(progressId)) {
    return res.status(409).json({ error: 'Login progress ID is already in use.' });
  }
  if (progressId) {
    loginProgress.set(progressId, 'waiting');
    res.on('close', () => loginProgress.delete(progressId));
  }
  try {
    await sessions.login(req, res, username, password, actUsername, actPassword, (phase) => {
      if (progressId && loginProgress.has(progressId)) loginProgress.set(progressId, phase);
    });
    res.json({ ok: true });
  } catch (err) {
    const invalidCredentials = [200, 302, 401, 403].includes(err.status);
    const service = err.service || 'Authentication';
    console.error(`${service} login failed:`, invalidCredentials ? 'credentials rejected' : 'service unavailable');
    res.status(invalidCredentials ? 401 : 502).json({
      error: invalidCredentials ? `${service} login failed. Check your credentials and try again.` : `Could not connect to ${service}.`,
    });
  } finally {
    if (progressId) loginProgress.delete(progressId);
  }
});

app.get('/api/login-progress', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const id = req.get('X-Login-Progress');
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid login progress ID.' });
  }
  res.json({ phase: loginProgress.get(id) || 'waiting' });
});

app.post('/api/logout', (req, res) => {
  sessions.logout(req, res);
  res.json({ ok: true });
});

app.get('/api/session', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ authenticated: Boolean(sessions.get(req)?.ems.authenticated), emsMode: is_test_mode ? 'test' : 'production' });
});

app.use('/api', (req, res, next) => {
  const session = sessions.get(req);
  if (!session || !session.ems.authenticated) {
    sessions.remove(req);
    return res.status(401).json({ error: 'Session expired. Log in again.' });
  }
  req.ems = session.ems;
  req.integrationSession = session;
  next();
});

// EMS lookup endpoints used by the UI to populate customers, entitlements and product metadata.
app.get('/api/customers', async (req, res) => {
  const ems = req.ems;
  try {
    res.json(await withSession(ems, () => ems.listCustomers()));
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/product-key-serial-number', async (req, res) => {
  const ems = req.ems;
  res.set('Cache-Control', 'no-store');
  try {
    await ensureNextProductKeySerialInitialized(ems);
    const nextSerial = await withSession(ems, () => ems.getNextProductKeySerial());
    if (nextSerial > 65535) {
      return res.status(409).json({ error: 'No serial numbers remain above 06000.' });
    }
    res.json({ nextSerial });
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/product-key-serial-numbers', async (req, res) => {
  const ems = req.ems;
  res.set('Cache-Control', 'no-store');
  try {
    const serialNumbers = await getUsedProductKeySerialNumbers(ems);
    res.json([...serialNumbers].sort((left, right) => left - right));
  } catch (err) {
    if (err.status === 401) {
      ems.authenticated = false;
      ems.cookies.clear();
    }
    console.error(err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/entitlements', async (req, res) => {
  const ems = req.ems;
  try {
    res.json(await withSession(ems, () => ems.listEntitlements()));
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/activations', async (req, res) => {
  const ems = req.ems;
  res.set('Cache-Control', 'no-store');
  try {
    const entitlements = await withSession(ems, () => ems.listEntitlementsForActivations());
    const keys = [];
    for (let index = 0; index < entitlements.length; index += 10) {
      const batch = await Promise.all(entitlements.slice(index, index + 10).map(async (entitlement) => ({
        entitlement,
        productKeys: await withSession(ems, () => ems.getProductKeysForActivations(
          entitlement.id ?? entitlement.entitlementId
        )),
      })));
      keys.push(...batch.flatMap(({ entitlement, productKeys }) => productKeys.map((key) => ({
        key,
        entitlement,
      }))));
    }

    const candidates = [];
    for (const { key, entitlement } of keys) {
      if (!key.activationIds.length) candidates.push({ aid: null, key, entitlement });
      for (const aid of key.activationIds || []) {
        candidates.push({ aid, key, entitlement });
      }
    }
    const uniqueAids = [...new Set(candidates.map(({ aid }) => aid).filter(Boolean))];
    const licensesByAid = new Map();
    for (let index = 0; index < uniqueAids.length; index += 10) {
      const batch = await Promise.all(uniqueAids.slice(index, index + 10).map(async (aid) => ({
        aid,
        license: await withSession(ems, () => ems.getActivationLicense(aid)),
      })));
      for (const { aid, license } of batch) licensesByAid.set(aid, license);
    }
    const activations = candidates.map(({ aid, key, entitlement }) => ({
      ...(aid ? licensesByAid.get(aid) : {
        aid: null, protectionKeyId: null, activationString: null,
      }),
      productKeyId: key.productKeyId,
      entitlementId: key.entitlementId,
      customerName: key.customerName ?? entitlement.customerName ?? entitlement.customer,
    }));
    res.json({ activations });
  } catch (err) {
    if (err.status === 401) {
      ems.authenticated = false;
      ems.cookies.clear();
    }
    console.error(err.message);
    res.status(502).json({ error: err.message });
  }
});

async function loadProtectionKeyHistory(ems, protectionKeyId) {
  const entitlementIds = await withSession(ems, () => ems.getProtectionKeyEntitlements(protectionKeyId));
  const candidates = [];
  const warnings = [];
  for (let index = 0; index < entitlementIds.length; index += 10) {
    const batch = await Promise.all(entitlementIds.slice(index, index + 10).map(async (entitlementId) => ({
      entitlementId,
      ...await withSession(ems, () => ems.getProtectionKeyActivationCandidates(entitlementId)),
    })));
    for (const { entitlementId, keys, missingUpdateProductKey } of batch) {
      if (missingUpdateProductKey) warnings.push(`Entitlement ${entitlementId}: EMS did not return an update product key ID.`);
      for (const key of keys) {
        if (!key.activationIds.length) warnings.push(`Entitlement ${entitlementId}: a product key has no activation IDs returned by EMS.`);
        for (const reference of key.activationReferences) {
          candidates.push({ ...reference, productKeyId: key.productKeyId, entitlementId });
        }
      }
    }
  }
  const keyIdsByAid = new Map();
  for (const { aid, protectionKeyId: candidateKeyId } of candidates) {
    if (!keyIdsByAid.has(aid)) keyIdsByAid.set(aid, new Set());
    keyIdsByAid.get(aid).add(candidateKeyId);
  }
  const eligibleCandidates = candidates.filter(({ aid, protectionKeyId: candidateKeyId, entitlementId }) => {
    if (!candidateKeyId || keyIdsByAid.get(aid).size !== 1) {
      warnings.push(`Entitlement ${entitlementId}: activation ${aid} has a missing or conflicting protection key ID.`);
      return false;
    }
    return candidateKeyId === protectionKeyId;
  });
  const results = new Map();
  const aids = [...new Set(eligibleCandidates.map(({ aid }) => aid))];
  for (let index = 0; index < aids.length; index += 10) {
    const batch = await Promise.all(aids.slice(index, index + 10).map(async (aid) => {
      const license = await withSession(ems, () => ems.getActivationLicense(aid));
      if (!String(license.protectionKeyId ?? '').trim()) return { aid, license: null, missingProtectionKeyId: true };
      if (String(license.protectionKeyId ?? '').trim() !== protectionKeyId) return { aid, license: null, wrongProtectionKeyId: true };
      try {
        const updateCounter = await withSession(ems, () => ems.getActivationUpdateCounter(protectionKeyId, aid));
        return { aid, license, updateCounter, counterError: null };
      } catch (err) {
        if (err.status === 401) throw err;
        console.error(`Key history lookup failed for activation: ${err.message}`);
        return { aid, license, updateCounter: null, counterError: err.message };
      }
    }));
    for (const result of batch) {
      results.set(result.aid, result);
      if (result.missingProtectionKeyId) warnings.push(`Activation ${result.aid}: EMS did not return a protection key ID.`);
      if (result.wrongProtectionKeyId) warnings.push(`Activation ${result.aid}: EMS returned a different protection key ID.`);
    }
  }
  const activations = eligibleCandidates.flatMap((candidate) => {
    const result = results.get(candidate.aid);
    if (!result.license) return [];
    return [{ ...candidate, ...result.license, updateCounter: result.updateCounter, counterError: result.counterError }];
  });
  return { activations, warnings };
}

app.get('/api/protection-keys/:id/activations', async (req, res) => {
  const ems = req.ems;
  const protectionKeyId = req.params.id;
  res.set('Cache-Control', 'no-store');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(protectionKeyId)) {
    return res.status(400).json({ error: 'Protection key ID is invalid.' });
  }
  try {
    res.json(await loadProtectionKeyHistory(ems, protectionKeyId));
  } catch (err) {
    console.error(err.message);
    res.status(err.status === 401 ? 401 : 502).json({ error: err.message });
  }
});

app.get('/api/protection-keys/:id/update-counters', async (req, res) => {
  const protectionKeyId = req.params.id;
  res.set('Cache-Control', 'no-store');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(protectionKeyId)) {
    return res.status(400).json({ error: 'Protection key ID is invalid.' });
  }
  try {
    const history = await loadProtectionKeyHistory(req.ems, protectionKeyId);
    res.json({
      activations: history.activations.map(({ entitlementId, aid, updateCounter, counterError }) =>
        ({ entitlementId, aid, updateCounter, counterError })),
      warnings: history.warnings,
    });
  } catch (err) {
    console.error(err.message);
    res.status(err.status === 401 ? 401 : 502).json({ error: err.message });
  }
});

app.get('/api/protection-keys/:id/entitlements', async (req, res) => {
  const protectionKeyId = req.params.id;
  res.set('Cache-Control', 'no-store');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(protectionKeyId)) {
    return res.status(400).json({ error: 'Protection key ID is invalid.' });
  }
  try {
    const ids = await withSession(req.ems, () => req.ems.getProtectionKeyEntitlements(protectionKeyId));
    const includeOriginal = req.query?.includeOriginal === '1';
    const updates = [];
    const originals = [];
    let mixedTypes = false;
    for (let index = 0; index < ids.length; index += 10) {
      const details = await Promise.all(ids.slice(index, index + 10).map((id) =>
        withSession(req.ems, () => req.ems.getEntitlementDetails(id, { includeCustomer: false }))
      ));
      for (const entitlement of details) {
        if (!Array.isArray(entitlement.lineItemTypes) || !entitlement.lineItemTypes.length ||
            entitlement.lineItemTypes.some((type) => typeof type !== 'string' || !type)) {
          throw new Error('EMS returned an entitlement without valid line item types.');
        }
        const isUpdate = entitlement.lineItemTypes.includes('ProtectionKey_Update');
        const isOriginal = entitlement.lineItemTypes.includes('Product_Key');
        if (includeOriginal && isOriginal && isUpdate) mixedTypes = true;
        if (isUpdate || (includeOriginal && isOriginal)) {
          if (!Array.isArray(entitlement.products)) {
            throw new Error('EMS returned an entitlement without a valid product list.');
          }
          const entry = {
            id: entitlement.id,
            state: entitlement.entState,
            createDate: entitlement.createDate,
            refId1: entitlement.refId1,
            customer: entitlement.customer,
            customerId: entitlement.customerId,
            products: entitlement.products.map(({ productId, productName }) => ({ productId, productName })),
          };
          if (isUpdate) updates.push({ ...entry, type: 3 });
          if (includeOriginal && isOriginal && !isUpdate) originals.push({ ...entry, type: 2 });
        }
      }
    }
    if (!includeOriginal) return res.json(updates);
    const originalError = mixedTypes || originals.length > 1
      ? 'EMS returned ambiguous product-key entitlements for this protection key.'
      : originals.length === 0 ? 'EMS did not return the original product-key entitlement for this protection key.' : '';
    res.json({ original: originalError ? null : originals[0], originalError, updates });
  } catch (err) {
    console.error(err.message);
    res.status(err.status === 401 ? 401 : 502).json({ error: err.message });
  }
});

app.get('/api/protection-keys/:id/v2cp', async (req, res) => {
  const protectionKeyId = req.params.id;
  res.set('Cache-Control', 'no-store');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(protectionKeyId)) {
    return res.status(400).json({ error: 'Protection key ID is invalid.' });
  }
  try {
    const history = await loadProtectionKeyHistory(req.ems, protectionKeyId);
    res.json({ package: buildHistoryV2cp(protectionKeyId, history) });
  } catch (err) {
    console.error(err.message);
    res.status(err.status === 401 ? 401 : 502).json({ error: err.message });
  }
});

app.post('/api/activations/:aid/pending-updates', async (req, res) => {
  const ems = req.ems;
  res.set('Cache-Control', 'no-store');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(req.params.aid)) {
    return res.status(400).json({ error: 'Activation ID is invalid.' });
  }
  try {
    const c2v = await withSession(ems, () => ems.getActivationC2V(req.params.aid));
    const packageXml = await ems.fetchPendingUpdates(c2v);
    res.json({ package: packageXml });
  } catch (err) {
    console.error(err.message);
    if (err.c2vDiagnostic) console.error('Saved C2V diagnostic:', JSON.stringify(err.c2vDiagnostic));
    res.status(err.status === 401 ? 401 : err.status === 400 ? 400 : err.status === 404 ? 404 : 502)
      .json({ error: err.message });
  }
});

app.get('/api/enforcements', async (req, res) => {
  const ems = req.ems;
  try {
    res.json(await withSession(ems, () =>
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
  const ems = req.ems;
  if (!/^[1-9]\d*$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Entitlement ID must be a positive number' });
  }
  try {
    const details = await withSession(ems, () => ems.getEntitlementDetails(req.params.id));
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
  const ems = req.ems;
  res.set('Cache-Control', 'no-store');
  if (!/^[1-9]\d*$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Entitlement ID must be a positive number' });
  }
  try {
    res.json(await withSession(ems, () => ems.getEntitlementProductKeys(req.params.id)));
  } catch (err) {
    console.error(err.message);
    res.status(err.status === 400 ? 400 : 502).json({ error: err.message });
  }
});

/** Reject malformed C2V inputs before contacting EMS. */
function validateC2VInput(c2v) {
  const trimmedC2V = typeof c2v === 'string' ? c2v.trim() : '';
  if (!trimmedC2V) {
    return 'A C2V value is required.';
  }

  if (Buffer.byteLength(trimmedC2V, 'utf8') > 10 * 1024 * 1024) {
    return 'C2V content is too large; keep it under 10 MB.';
  }

  const suspiciousControlChars = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(trimmedC2V);
  if (suspiciousControlChars) {
    return 'C2V content contains invalid control characters.';
  }

  return null;
}

/** Reject malformed activation inputs before contacting EMS. */
function validateActivationInput(productKeyId, c2v) {
  const trimmedKey = typeof productKeyId === 'string' ? productKeyId.trim() : '';
  if (!trimmedKey || trimmedKey.length > 128 || /\s/.test(trimmedKey) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(trimmedKey)) {
    return 'Provide a product key value that looks like a real key and does not contain whitespace.';
  }
  return validateC2VInput(c2v);
}

app.post('/api/pending-updates', express.json({ limit: '20mb' }), async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const c2v = req.body?.c2v;
  const inputError = validateC2VInput(c2v);
  if (inputError) return res.status(400).json({ error: inputError });
  try {
    res.json({ package: await req.ems.fetchPendingUpdates(c2v.trim()) });
  } catch (err) {
    console.error(err.message);
    res.status(err.status === 400 ? 400 : err.status === 404 ? 404 : 502).json({ error: err.message });
  }
});

app.post('/api/entitlements/:id/activate', express.json({ limit: '20mb' }), async (req, res) => {
  const ems = req.ems;
  res.set('Cache-Control', 'no-store');
  if (!/^[1-9]\d*$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Entitlement ID must be a positive number.', outcomeUnknown: false });
  }

  const { productKeyId, c2v } = req.body || {};
  const inputError = validateActivationInput(productKeyId, c2v);
  if (inputError) {
    return res.status(400).json({ error: inputError, outcomeUnknown: false });
  }

  try {
    const entitlementKeyId = productKeyId.trim();
    const entitlement = await withSession(ems, () =>
      ems.getEntitlementDetails(req.params.id, { includeCustomer: false })
    );
    if (String(entitlement.entState ?? entitlement.state ?? '').toUpperCase() !== 'PRODUCT_KEY_GENERATED') {
      return res.status(400).json({
        error: 'Only generated Product Key entitlements can be activated.',
        outcomeUnknown: false,
      });
    }
    const items = Array.isArray(entitlement.entitlementItem)
      ? entitlement.entitlementItem
      : [entitlement.entitlementItem];
    const keyBelongsToEntitlement = items.some((item) =>
      item?.lineItemType === 'Product_Key' &&
      (Array.isArray(item.productKeyId) ? item.productKeyId : [item.productKeyId])
        .some((key) => String(key) === entitlementKeyId)
    );
    if (!keyBelongsToEntitlement) {
      return res.status(400).json({
        error: 'The product key does not belong to this entitlement.',
        outcomeUnknown: false,
      });
    }
    res.json(await withSession(ems, () => ems.activateProductKey(productKeyId.trim(), c2v.trim())));
  } catch (err) {
    console.error(err.message);
    res.status(err.status === 400 ? 400 : 502).json({ error: err.message, outcomeUnknown: Boolean(err.outcomeUnknown) });
  }
});

app.get('/api/catalog/products/:id/read-only-memory', async (req, res) => {
  const ems = req.ems;
  if (!/^[1-9]\d*$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Product ID must be a positive number' });
  }
  try {
    res.json(await withSession(ems, () => ems.getProductReadOnlyMemory(req.params.id)));
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
  const ems = req.ems;
  try {
    res.json(await getEntitlementProducts(ems));
  } catch (err) {
    if (err.status === 401) {
      ems.authenticated = false;
      ems.cookies.clear();
    }
    console.error(err.message);
    res.status(502).json({ error: err.message });
  }
});

// Builds and validates the entitlement payload before either creating a new draft or updating
// an existing one in EMS. This is the central business logic for entitlement management.
const saveEntitlement = async (req, res) => {
  const ems = req.ems;
  const existingId = req.params?.id;
  if (existingId !== undefined && !/^[1-9]\d*$/.test(existingId)) {
    return res.status(400).json({ error: 'Entitlement ID must be a positive number' });
  }
  const {
    customerId,
    productIds,
    description,
    refId1,
    refId2,
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
      (refId2 !== undefined && (typeof refId2 !== 'string' || refId2.length > 250))) {
    return res.status(400).json({ error: 'Description must be 510 characters or fewer; reference IDs must be 250 characters or fewer' });
  }
  if (!existingId && (typeof refId1 !== 'string' || !refId1.trim())) {
    return res.status(400).json({ error: 'Irricad Order Code (refID 1) is required.' });
  }

  try {
    let existing = null;
    if (existingId) {
      existing = await withSession(ems, () => ems.getEntitlementDetails(existingId));
      if (String(existing.entState).toUpperCase() !== 'DRAFT') {
        return res.status(400).json({ error: 'Only draft entitlements can be edited.' });
      }
    }
    const customers = await withSession(ems, () => ems.listCustomers());
    const selectedCustomerId = String(customerId).trim();
    const selectedCustomer = customers.find((customer) =>
      [customer.customerId, customer.id].some((id) => String(id ?? '').trim() === selectedCustomerId)
    );
    if (!selectedCustomer) {
      return res.status(400).json({ error: 'The selected customer is no longer in the EMS customer list. Reload customers and try again.' });
    }

    const vendorId = process.env.EMS_VENDOR_ID || '2';
    const { baseProductId, modifications, optionalProducts, versionProducts } = await getEntitlementProducts(ems);
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
    const enforcements = await withSession(ems, () => ems.listEnforcements(vendorId));
    if (!enforcements.some((enforcement) => String(enforcement.id) === SENTINEL_LDK_ENFORCEMENT_ID)) {
      return res.status(400).json({ error: 'Sentinel LDK enforcement (1) is not available in EMS.' });
    }
    const productFiles = Object.fromEntries(await Promise.all(allProductIds.map(async (productId) => [
      String(productId),
      await withSession(ems, () => ems.getProductReadOnlyMemory(productId)),
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
      const hadLease = existing?.products?.some((product) => String(product.productId) === formData.lease.id);
      const previousExpiry = existing?.products?.find((product) => String(product.productId) === baseProductId)
        ?.memorySegments?.find((segment) => String(segment.id) === String(expiry.id))?.text;
      const expiryContent = existing && !hadLease ? previousExpiry || expiry.content : expiry.content;
      if (expiryContent === undefined) {
        return res.status(400).json({ error: 'Cannot determine the existing expiry memory value; edit this draft in EMS.' });
      }
      resolvedMemoryValues = memoryValues.filter((value) =>
        !value || String(value.productId) !== baseProductId || String(value.segmentId) !== String(expiry.id)
      );
      resolvedMemoryValues.push({ productId: baseProductId, segmentId: expiry.id, content: expiryContent });
    }
    const memorySegments = validateMemoryValues(allProductIds, productFiles, resolvedMemoryValues);

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
    const serialNumberValue = Number(BigInt(`0x${digits}`));
    if (!existingId && serialNumberValue < 6001) {
      return res.status(400).json({ error: 'The serial number must be at least 6,001.' });
    }
    const previousSerialText = existing?.products
      ?.find((product) => String(product.productId) === baseProductId)
      ?.memorySegments?.find((segment) => segment.saot &&
        String(segment.name ?? '').trim().toLowerCase() === 'serial number')?.text;
    const serialNumberChanged = !existingId ||
      decodeProductKeySerial(previousSerialText) !== serialNumberValue;

    const today = new Date();
    const startDate = existing?.startDate ?? requestedStartDate ?? today.toISOString().slice(0, 10);
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
      refId1: existingId ? refId1 : refId1 ?? '',
      refId2: existingId ? refId2 : refId2 ?? '',
      memorySegments,
    };
    if (existingId) {
      entitlementData.editableProductIds = [
        ...formData.accessProducts, ...formData.optionalProducts, ...formData.versionProducts, formData.lease,
      ].map((product) => product.id);
      const previousProductIds = new Set((existing.products || []).map((product) => String(product.productId)));
      const changedMemoryIds = new Set();
      for (const productId of allProductIds) {
        for (const file of productFiles[productId]) {
          for (const segment of file.segments) {
            const name = String(segment.name ?? '').trim().toLowerCase();
            if (segment.saot && (!previousProductIds.has(productId) ||
                (productId === baseProductId && (name === 'serial number' ||
                  (name === 'expiry date' && (leaseSelected || previousProductIds.has(formData.lease.id))))))) {
              changedMemoryIds.add(String(segment.id));
            }
          }
        }
      }
      entitlementData.changedMemorySegmentIds = [...changedMemoryIds];
      const result = await withProductKeySerialLock(async () => {
        if (serialNumberChanged) {
          const usedSerialNumbers = await getUsedProductKeySerialNumbers(ems, existingId);
          if (usedSerialNumbers.has(serialNumberValue)) {
            throw duplicateProductKeySerialError(serialNumberValue);
          }
        }
        return ems.updateEntitlement(existingId, entitlementData);
      });
      return res.status(200).json(result);
    }
    await ensureNextProductKeySerialInitialized(ems);
    let serialCounterError;
    const result = await withProductKeySerialLock(async () => {
      const usedSerialNumbers = await getUsedProductKeySerialNumbers(ems);
      if (usedSerialNumbers.has(serialNumberValue)) {
        throw duplicateProductKeySerialError(serialNumberValue);
      }
      const nextSerial = await withSession(ems, () => ems.getNextProductKeySerial());
      if (nextSerial !== serialNumberValue) {
        const error = new Error(`The next serial number is ${String(nextSerial).padStart(5, '0')}. Reload the form and try again.`);
        error.status = 409;
        throw error;
      }
      const created = await withSession(ems, () => ems.createEntitlement(entitlementData));
      try {
        await advanceProductKeySerial(ems, serialNumberValue);
      } catch (err) {
        serialCounterError = err;
      }
      return created;
    });
    if (serialCounterError) {
      console.error(`Draft saved, but the next serial number could not be updated: ${serialCounterError.message}`);
      return res.status(201).json({
        ...result,
        serialNumberUpdated: false,
        serialNumberError: serialCounterError.message,
      });
    }
    return res.status(201).json({ ...result, serialNumber: serialNumberValue, serialNumberUpdated: true });
  } catch (err) {
    if (err.status === 401) {
      ems.authenticated = false;
      ems.cookies.clear();
    }
    console.error(err.message);
    res.status(err.status === 400 || err.status === 409 ? err.status : 502).json({ error: err.message });
  }
};
app.post('/api/entitlements', express.json(), saveEntitlement);
app.put('/api/entitlements/:id', express.json(), saveEntitlement);
app.post('/api/entitlements/:id/produce', async (req, res) => {
  const ems = req.ems;
  if (!/^[1-9]\d*$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Entitlement ID must be a positive number.' });
  }
  try {
    res.json(await withSession(ems, () => ems.produceEntitlement(req.params.id)));
  } catch (err) {
    console.error(err.message);
    res.status(err.status === 400 ? 400 : 502).json({ error: err.message, outcomeUnknown: Boolean(err.outcomeUnknown) });
  }
});
app.post('/api/entitlements/:id/reopen', async (req, res) => {
  const ems = req.ems;
  if (!/^[1-9]\d*$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Entitlement ID must be a positive number.' });
  }
  try {
    res.json(await withSession(ems, () => ems.reopenEntitlement(req.params.id)));
  } catch (err) {
    if (err.status === 401) {
      ems.authenticated = false;
      ems.cookies.clear();
    }
    console.error(err.message);
    res.status(err.status === 400 ? 400 : 502).json({
      error: err.message,
      outcomeUnknown: Boolean(err.outcomeUnknown),
    });
  }
});
app.delete('/api/entitlements/:id', async (req, res) => {
  const ems = req.ems;
  if (!/^[1-9]\d*$/.test(req.params.id)) {
    return res.status(400).json({ error: 'Entitlement ID must be a positive number' });
  }
  try {
    const entitlement = await withSession(ems, () => ems.getEntitlementDetails(req.params.id));
    if (String(entitlement.entState ?? '').toUpperCase() !== 'DRAFT') {
      return res.status(400).json({ error: 'Only draft entitlements can be deleted.' });
    }
    res.json(await withSession(ems, () => ems.deleteEntitlement(req.params.id)));
  } catch (err) {
    if (err.status === 401) {
      ems.authenticated = false;
      ems.cookies.clear();
    }
    console.error(err.message);
    res.status(502).json({ error: err.message });
  }
});

/** Run an Act! operation and discard the browser session if Act! authentication expires. */
async function callAct(req, operation) {
  try {
    return await operation(req.integrationSession.act);
  } catch (err) {
    if (err.status === 401) sessions.remove(req);
    throw err;
  }
}

app.get('/api/act/companies', async (req, res) => {
  try {
    res.json(await callAct(req, (act) => act.listCompanies()));
  } catch (err) {
    console.error(err.message);
    res.status(err.status === 401 ? 401 : 502).json({ error: err.status === 401 ? 'Act! session expired. Log in again.' : err.message });
  }
});

app.get('/api/act/companies/:id/divisions', async (req, res) => {
  try {
    res.json(await callAct(req, (act) => act.getCompanyDivisions(req.params.id)));
  } catch (err) {
    console.error(err.message);
    res.status(err.status === 401 ? 401 : 502).json({
      error: err.status === 401 ? 'Act! session expired. Log in again.' : err.message,
    });
  }
});

app.post('/api/act/companies/:id/add-to-ems', express.json(), async (req, res) => {
  const ems = req.ems;
  try {
    const company = await callAct(req, (act) => act.getCompany(req.params.id));
    if (!company || typeof company.name !== 'string' || !company.name.trim()) {
      return res.status(502).json({ error: 'Act! returned a company without a name' });
    }
    const divisions = company.hasDivisions === true ? [] : await callAct(req, (act) => act.getCompanyDivisions(req.params.id));
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
      const parentDivisions = await callAct(req, (act) => act.getCompanyDivisions(parentId));
      if (!Array.isArray(parentDivisions) ||
          !parentDivisions.some((division) =>
            division && String(division.id) === String(company.id || req.params.id)
          )) {
        return res.status(400).json({ error: 'The specified parent does not contain this ACT company' });
      }
      const parent = await callAct(req, (act) => act.getCompany(parentId));
      if (!parent || typeof parent.name !== 'string' || !parent.name.trim()) {
        return res.status(502).json({ error: 'Act! returned a parent company without a name' });
      }
      emsName = `${parent.name.trim()} - ${company.name.trim()}`;
    }

    const reference = String(company.id || req.params.id);
    const existing = await withSession(ems, () => ems.listCustomers());
    if (existing.some((c) => String(c.refId1 ?? '').trim().toLowerCase() === reference.toLowerCase())) {
      return res.status(409).json({ error: 'This ACT company already exists in EMS' });
    }

    const location = await withSession(ems, () => ems.createCustomer({
      name: emsName,
      reference,
      vendorId: process.env.EMS_VENDOR_ID || 2,
      phone: company.businessPhone || company.phone || '',
    }));
    res.status(201).json({ location });
  } catch (err) {
    console.error(err.message);
    res.status(err.status === 401 ? 401 : 502).json({
      error: err.status === 401
        ? 'Session expired. Log in again.'
        : `${err.message}${err.body ? `: ${typeof err.body === 'string' ? err.body : JSON.stringify(err.body)}` : ''}`,
    });
  }
});

// Final catch-all for unknown routes: API requests return JSON 404s while page requests fall back
// to the app's static 404 page.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(404).type('text').send('Not found');
  fs.readFile(path.join(publicDir, '404.html'), 'utf8', (err, html) => {
    if (err) return res.status(404).type('text').send('Page not found');
    res.status(404).set('Cache-Control', 'no-store').type('html').send(renderPage(html, path.join(projectRoot, 'partials'), '/404.html', is_test_mode));
  });
});

// Start the HTTP server and print both localhost and LAN URLs for convenience when running
// the app on a development machine.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`EMS product IDs: ${is_test_mode ? 'test' : 'production'}`);
  console.log(`Local: http://localhost:${PORT}`);
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((network) => network && network.family === 'IPv4' && !network.internal)
    .map((network) => `http://${network.address}:${PORT}`);
  for (const address of addresses) console.log(`Network: ${address}`);
  console.log('Press Ctrl+C to stop the server.');
});
