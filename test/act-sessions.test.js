const test = require('node:test');
const assert = require('node:assert/strict');
const { createActSessions } = require('../src/act-sessions');
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

test('EMS users and their Act credentials are isolated', async () => {
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
  let sessionStore;
  let expireAct = false;
  let expireEms = false;
  let emsCalls = 0;
  class ActClient {
    constructor({ baseUrl }) { assert.equal(baseUrl, 'https://act.example'); }
    async authenticate(username, password) {
      actCredentials.push([username, password]);
      if (password === 'bad') { const error = new Error('Rejected'); error.status = 401; throw error; }
      this.name = username;
    }
    async listCompanies() {
      if (expireAct) { expireAct = false; const error = new Error('Expired'); error.status = 401; throw error; }
      return [this.name];
    }
  }
  class EmsClient {
    constructor({ username, password }) { this.username = username; this.password = password; this.cookies = new Map(); }
    async authenticate() {
      if (this.password === 'bad') { const error = new Error('Rejected'); error.status = 302; throw error; }
      this.authenticated = true;
    }
    async listCustomers() {
      emsCalls++;
      if (expireEms) { const error = new Error('EMS session expired'); error.status = 401; throw error; }
      return [this.username];
    }
  }
  const root = path.join(__dirname, '..');
  const customRequire = (name) => {
    if (name === 'express') return express;
    if (name === 'fs') return { existsSync: () => false, watch() {} };
    if (name === './act-client') return { ActClient };
    if (name === './ems-client') return { EmsClient };
    if (name === './act-sessions') return {
      createActSessions(factory) { sessionStore = createActSessions(factory); return sessionStore; },
    };
    if (name === './entitlement-form-data') return { loadFormData: () => ({}) };
    if (name.startsWith('.')) return require(path.resolve(root, 'src', name));
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8'), {
    require: customRequire, __dirname: path.join(root, 'src'),
    process: { argv: ['node', 'server.js'], env: { IS_TEST_MODE: 'false', PRODUCTION_EMS_URL: 'https://ems.example', ACT_URL: 'https://act.example', ACT_USER: 'unused', ACT_PASS: 'unused' } }, console,
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
  const credentials = (username, password, actUsername, actPassword) => ({ username, password, actUsername, actPassword });
  await routes.get('POST /api/login')({ headers: {}, body: credentials('alice', 'x', 'act-alice', 'act-pass-a') }, alice);
  await routes.get('POST /api/login')({ headers: {}, body: credentials('bob', 'x', 'act-bob', 'act-pass-b') }, bob);
  assert.equal(sessionStore.get(request(alice)).ems.password, undefined);
  assert.equal(sessionStore.get(request(alice)).act.password, undefined);
  const listAlice = res(), listBob = res();
  await Promise.all([
    invokeProtected('GET /api/customers', request(alice), listAlice),
    invokeProtected('GET /api/customers', request(bob), listBob),
  ]);
  assert.deepEqual(listAlice.body, ['alice']);
  assert.deepEqual(listBob.body, ['bob']);
  const bad = res();
  await routes.get('POST /api/login')({ ...request(alice), body: credentials('alice', 'bad', 'act-alice', 'act-pass-a') }, bad);
  assert.equal(bad.statusCode, 401);
  const badAct = res();
  await routes.get('POST /api/login')({ ...request(alice), body: credentials('alice', 'x', 'act-alice', 'bad') }, badAct);
  assert.equal(badAct.statusCode, 401);
  const companies = res();
  await invokeProtected('GET /api/act/companies', request(alice), companies);
  assert.deepEqual(companies.body, ['act-alice']);
  assert.deepEqual(actCredentials, [['act-alice', 'act-pass-a'], ['act-bob', 'act-pass-b'], ['act-alice', 'bad']]);
  expireAct = true;
  const expired = res();
  await invokeProtected('GET /api/act/companies', request(alice), expired);
  assert.equal(expired.statusCode, 401);
  const afterExpired = res();
  await invokeProtected('GET /api/customers', request(alice), afterExpired);
  assert.equal(afterExpired.statusCode, 401);
  await routes.get('POST /api/logout')(request(alice), res());
  const after = res();
  await invokeProtected('GET /api/customers', request(alice), after);
  assert.equal(after.statusCode, 401);
  const stillBob = res();
  await invokeProtected('GET /api/customers', request(bob), stillBob);
  assert.deepEqual(stillBob.body, ['bob']);
  expireEms = true;
  const callsBeforeExpiry = emsCalls;
  const expiredEms = res();
  await invokeProtected('GET /api/customers', request(bob), expiredEms);
  assert.match(expiredEms.body.error, /session expired/);
  assert.equal(emsCalls, callsBeforeExpiry + 1);
  const session = res();
  routes.get('GET /api/session')(request(bob), session);
  assert.equal(session.body.authenticated, false);
});

test('server requires the selected EMS address and Act address', () => {
  const root = path.join(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8');
  const customRequire = (name) => {
    if (name === 'fs') return { existsSync: () => false };
    if (name === './entitlement-form-data') return { loadFormData: () => ({}) };
    if (name.startsWith('.')) return require(path.resolve(root, 'src', name));
    return require(name);
  };
  for (const [env, expected] of [
    [{ IS_TEST_MODE: 'false', PRODUCTION_EMS_URL: 'https://ems.example' }, 'Set ACT_URL in .env.'],
    [{ IS_TEST_MODE: 'true', ACT_URL: 'https://act.example' }, 'Set TEST_EMS_URL in .env.'],
    [{ PRODUCTION_EMS_URL: 'https://ems.example', ACT_URL: 'https://act.example' }, 'Set IS_TEST_MODE to true or false in .env.'],
  ]) {
    const errors = [];
    assert.throws(() => vm.runInNewContext(source, {
      require: customRequire, __dirname: path.join(root, 'src'),
      process: { argv: ['node', 'server.js'], env, exit(code) { throw new Error(`Exit ${code}`); } },
      console: { error(message) { errors.push(message); } },
    }), /Exit 1/);
    assert.deepEqual(errors, [expected]);
  }
});

test('extracted customer and custom entity scripts mount their pages', () => {
  const scripts = path.join(__dirname, '..', 'public', 'pages');
  for (const page of ['index', 'custom-entities']) {
    let definition;
    let target;
    let reload;
    let reloaded = false;
    class EventSource {
      constructor(url) { assert.equal(url, '/__dev/reload'); }
      addEventListener(event, callback) { assert.equal(event, 'reload'); reload = callback; }
    }
    vm.runInNewContext(fs.readFileSync(path.join(scripts, `${page}.js`), 'utf8'), {
      Vue: { createApp: (options) => { definition = options; return { mount: (value) => { target = value; } }; } },
      EventSource,
      window: { location: { reload() { reloaded = true; } } },
    });
    assert.equal(target, '#app');
    assert.ok(definition.methods);
    if (page === 'index') {
      assert.ok(definition.components.CompanyTreeNode);
      reload();
      assert.equal(reloaded, true);
    }
  }
});

test('real HTTP login protects pages and API requests', async () => {
  const express = require('express');
  let server;
  const watchers = new Map();
  const createApp = () => {
    const app = express();
    const listen = app.listen.bind(app);
    app.listen = () => { server = listen(0, '127.0.0.1'); };
    return app;
  };
  createApp.static = express.static;
  createApp.json = express.json;
  class EmsClient {
    constructor({ username, password }) { this.username = username; this.password = password; }
    async authenticate() { this.authenticated = true; }
    async listCustomers() { return [this.username]; }
  }
  class ActClient {
    async authenticate(username, password) { this.name = username; assert.equal(password, 'act-password'); }
    async listCompanies() { return [this.name]; }
  }
  const root = path.join(__dirname, '..');
  const customRequire = (name) => {
    if (name === 'express') return createApp;
    if (name === 'fs') return { ...fs, existsSync: () => false, watch(dir, listener) { watchers.set(dir, listener); } };
    if (name === './ems-client') return { EmsClient };
    if (name === './act-client') return { ActClient };
    if (name.startsWith('.')) return require(path.resolve(root, 'src', name));
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src', 'server.js'), 'utf8'), {
    require: customRequire, __dirname: path.join(root, 'src'),
    process: { argv: ['node', 'server.js'], env: { IS_TEST_MODE: 'false', PRODUCTION_EMS_URL: 'https://ems.example', ACT_URL: 'https://act.example' } }, console,
  });
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const reload = await fetch(`${base}/__dev/reload`);
    const reloadReader = reload.body.getReader();
    try {
      watchers.get(path.join(root, 'public', 'pages'))('change', 'entitlements.js');
      assert.match(new TextDecoder().decode((await reloadReader.read()).value), /event: reload/);
      watchers.get(path.join(root, 'public'))('change', 'entitlements.html');
      assert.match(new TextDecoder().decode((await reloadReader.read()).value), /event: reload/);
      watchers.get(path.join(root, 'public'))('change', 'entitlement-values.js');
      assert.match(new TextDecoder().decode((await reloadReader.read()).value), /event: reload/);
    } finally {
      await reloadReader.cancel();
    }
    const page = await fetch(`${base}/entitlements.html`, { redirect: 'manual' });
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/login.html');
    const loginPage = await fetch(`${base}/login.html`);
    assert.equal(loginPage.headers.get('cache-control'), 'no-store');
    const loginHtml = await loginPage.text();
    assert.match(loginHtml, /! WARNING: This is the Production EMS !/);
    assert.match(loginHtml, /<script src="\/login-credentials\.js"><\/script>\s*<script src="\/pages\/login\.js"><\/script>/);
    const missingPage = await fetch(`${base}/missing-page`);
    assert.equal(missingPage.status, 404);
    assert.equal(missingPage.headers.get('cache-control'), 'no-store');
    assert.match(await missingPage.text(), /! WARNING: This is the Production EMS !/);
    assert.equal((await fetch(`${base}/api/customers`)).status, 401);
    assert.equal((await fetch(`${base}/vendor/forge.min.js`)).status, 200);
    assert.equal((await fetch(`${base}/login-crypto-worker.js`)).status, 200);
    for (const page of ['index', 'entitlements', 'activations', 'create-entitlement-form', 'update-entitlement-form', 'custom-entities', 'login']) {
      const script = await fetch(`${base}/pages/${page}.js`);
      assert.equal(script.status, 200, `${page} script is served`);
      assert.match(script.headers.get('content-type'), /javascript/);
    }
    const login = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'password', actUsername: 'act-alice', actPassword: 'act-password' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const customers = await fetch(`${base}/api/customers`, { headers: { Cookie: cookie } });
    assert.deepEqual(await customers.json(), ['alice']);
    const act = await fetch(`${base}/api/act/companies`, { headers: { Cookie: cookie } });
    assert.equal(act.status, 200);
    assert.deepEqual(await act.json(), ['act-alice']);
    const protectedPage = await fetch(`${base}/entitlements.html`, { headers: { Cookie: cookie } });
    assert.equal(protectedPage.status, 200);
    assert.match(await protectedPage.text(), /! WARNING: This is the Production EMS !/);
    for (const page of ['index', 'entitlements', 'activations', 'create-entitlement-form', 'update-entitlement-form', 'custom-entities']) {
      const html = await (await fetch(`${base}/${page}.html`, { headers: { Cookie: cookie } })).text();
      assert.ok(html.includes(`<script src="/pages/${page}.js"></script>`), `${page} loads its script`);
      const vueIndex = html.indexOf('vue.global.prod.js');
      assert.ok(vueIndex >= 0 && vueIndex < html.indexOf(`/pages/${page}.js`), `${page} loads Vue first`);
      if (page === 'create-entitlement-form' || page === 'update-entitlement-form') {
        assert.ok(html.indexOf('/entitlement-values.js') > vueIndex);
        assert.ok(html.indexOf('/entitlement-values.js') < html.indexOf(`/pages/${page}.js`));
      }
    }
    await fetch(`${base}/api/logout`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal((await fetch(`${base}/api/customers`, { headers: { Cookie: cookie } })).status, 401);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
