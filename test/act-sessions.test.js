const test = require('node:test');
const assert = require('node:assert/strict');
const { createActSessions } = require('../act-sessions');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function response() {
  return {
    cookie(name, value, options) { this.name = name; this.value = value; this.options = options; },
    clearCookie(name, options) { this.cleared = { name, options }; },
  };
}
const request = (res) => ({ headers: { cookie: `${res.name}=${res.value}` }, secure: true });

test('Act logins and logout are isolated per browser', async () => {
  const sessions = createActSessions(() => ({
    async authenticate(username, password) {
      if (password === 'bad') throw new Error('Invalid credentials');
      this.username = username;
    },
  }));
  const first = response(), second = response();
  await sessions.login({ headers: {}, secure: true }, first, 'alice', 'good');
  await sessions.login({ headers: {}, secure: true }, second, 'bob', 'good');
  assert.notEqual(first.value, second.value);
  assert.equal(first.options.httpOnly, true);
  assert.equal(first.options.sameSite, 'strict');
  assert.equal(first.options.secure, true);
  assert.equal(sessions.get(request(first)).username, 'alice');
  assert.equal(sessions.get(request(second)).username, 'bob');
  await assert.rejects(() => sessions.login(request(first), response(), 'charlie', 'bad'));
  assert.equal(sessions.get(request(first)).username, 'alice');
  sessions.logout(request(first), response());
  assert.equal(sessions.get(request(first)), null);
  assert.equal(sessions.get(request(second)).username, 'bob');
});

test('a successful replacement login invalidates the old session', async () => {
  const sessions = createActSessions(() => ({ async authenticate(name) { this.name = name; } }));
  const old = response(), next = response();
  await sessions.login({ headers: {} }, old, 'old', 'password');
  await sessions.login(request(old), next, 'new', 'password');
  assert.equal(sessions.get(request(old)), null);
  assert.equal(sessions.get(request(next)).name, 'new');
  assert.equal(sessions.get({ headers: { cookie: 'integration_session=invalid' } }), null);
});

test('EMS users are isolated and Act uses configured credentials', async () => {
  const routes = new Map();
  let authenticateApi;
  let authenticatePage;
  const app = {
    get(route, ...handlers) { routes.set(`GET ${route}`, handlers.at(-1)); },
    post(route, ...handlers) { routes.set(`POST ${route}`, handlers.at(-1)); },
    put() {}, delete() {},
    use(route, handler) {
      if (route === '/api') authenticateApi = handler;
      if (typeof route === 'function' && !authenticatePage) authenticatePage = route;
    },
    listen() {},
  };
  const express = () => app;
  express.static = express.json = () => {};
  const actCredentials = [];
  let expireAct = false;
  class ActClient {
    async authenticate(username, password) { actCredentials.push([username, password]); }
    async listCompanies() {
      if (expireAct) { expireAct = false; const error = new Error('Expired'); error.status = 401; throw error; }
      return ['company'];
    }
  }
  class EmsClient {
    constructor({ username, password }) { this.username = username; this.password = password; }
    async authenticate() {
      if (this.password === 'bad') { const error = new Error('Rejected'); error.status = 302; throw error; }
      this.authenticated = true;
    }
    async listCustomers() { return [this.username]; }
  }
  const root = path.join(__dirname, '..');
  const customRequire = (name) => {
    if (name === 'express') return express;
    if (name === 'fs') return { existsSync: () => false, watch() {} };
    if (name === './act-client') return { ActClient };
    if (name === './ems-client') return { EmsClient };
    if (name === './entitlement-form-data') return { loadFormData: () => ({}) };
    if (name.startsWith('./')) return require(path.join(root, name));
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), {
    require: customRequire, __dirname: root,
    process: { env: { EMS_URL: 'https://ems.example', ACT_USER: 'service', ACT_PASS: 'service-password' } }, console,
  });
  const res = () => ({
    statusCode: 200,
    cookie(name, value) { this.name = name; this.value = value; },
    clearCookie() {},
    set() { return this; },
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
    redirect(location) { this.location = location; return this; },
  });
  const invokeProtected = async (route, req, response) => {
    let allowed = false;
    authenticateApi(req, response, () => { allowed = true; });
    if (allowed) await routes.get(route)(req, response);
  };
  const unauthorized = res();
  await invokeProtected('GET /api/customers', { headers: {} }, unauthorized);
  assert.equal(unauthorized.statusCode, 401);
  const page = res();
  authenticatePage({ method: 'GET', path: '/entitlements.html', headers: {} }, page, () => assert.fail('page should require login'));
  assert.equal(page.location, '/login.html');
  const alice = res(), bob = res();
  await routes.get('POST /api/login')({ headers: {}, body: { username: 'alice', password: 'x' } }, alice);
  await routes.get('POST /api/login')({ headers: {}, body: { username: 'bob', password: 'x' } }, bob);
  const listAlice = res(), listBob = res();
  await Promise.all([
    invokeProtected('GET /api/customers', request(alice), listAlice),
    invokeProtected('GET /api/customers', request(bob), listBob),
  ]);
  assert.deepEqual(listAlice.body, ['alice']);
  assert.deepEqual(listBob.body, ['bob']);
  const bad = res();
  await routes.get('POST /api/login')({ ...request(alice), body: { username: 'alice', password: 'bad' } }, bad);
  assert.equal(bad.statusCode, 401);
  const companies = res();
  await invokeProtected('GET /api/act/companies', request(alice), companies);
  assert.deepEqual(companies.body, ['company']);
  assert.deepEqual(actCredentials, [['service', 'service-password']]);
  expireAct = true;
  const retried = res();
  await invokeProtected('GET /api/act/companies', request(alice), retried);
  assert.deepEqual(retried.body, ['company']);
  assert.deepEqual(actCredentials, [['service', 'service-password'], ['service', 'service-password']]);
  await routes.get('POST /api/logout')(request(alice), res());
  const after = res();
  await invokeProtected('GET /api/customers', request(alice), after);
  assert.equal(after.statusCode, 401);
  const stillBob = res();
  await invokeProtected('GET /api/customers', request(bob), stillBob);
  assert.deepEqual(stillBob.body, ['bob']);
});

test('real HTTP login protects pages and API requests', async () => {
  const express = require('express');
  let server;
  const createApp = () => {
    const app = express();
    const listen = app.listen.bind(app);
    app.listen = () => { server = listen(0, '127.0.0.1'); };
    return app;
  };
  createApp.static = express.static;
  createApp.json = express.json;
  class EmsClient {
    constructor({ username }) { this.username = username; }
    async authenticate() { this.authenticated = true; }
    async listCustomers() { return [this.username]; }
  }
  const root = path.join(__dirname, '..');
  const customRequire = (name) => {
    if (name === 'express') return createApp;
    if (name === 'fs') return { ...fs, existsSync: () => false, watch() {} };
    if (name === './ems-client') return { EmsClient };
    if (name.startsWith('./')) return require(path.join(root, name));
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), {
    require: customRequire, __dirname: root,
    process: { env: { EMS_URL: 'https://ems.example' } }, console,
  });
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(`${base}/entitlements.html`, { redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/login.html');
    assert.equal((await fetch(`${base}/api/customers`)).status, 401);
    const login = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'password' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const customers = await fetch(`${base}/api/customers`, { headers: { Cookie: cookie } });
    assert.deepEqual(await customers.json(), ['alice']);
    const act = await fetch(`${base}/api/act/companies`, { headers: { Cookie: cookie } });
    assert.equal(act.status, 502);
    assert.match((await act.json()).error, /ACT_USER and ACT_PASS/);
    assert.equal((await fetch(`${base}/entitlements.html`, { headers: { Cookie: cookie } })).status, 200);
    await fetch(`${base}/api/logout`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal((await fetch(`${base}/api/customers`, { headers: { Cookie: cookie } })).status, 401);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
