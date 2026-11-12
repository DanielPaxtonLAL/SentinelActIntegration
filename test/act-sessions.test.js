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
  assert.equal(sessions.get({ headers: { cookie: 'act_session=invalid' } }), null);
});

test('Act routes use the requesting browser session', async () => {
  const routes = new Map();
  const app = {
    get(route, ...handlers) { routes.set(`GET ${route}`, handlers.at(-1)); },
    post(route, ...handlers) { routes.set(`POST ${route}`, handlers.at(-1)); },
    put() {}, delete() {}, use() {}, listen() {},
  };
  const express = () => app;
  express.static = express.json = () => {};
  class ActClient {
    async authenticate(username) { this.name = username; }
    async listCompanies() { return [this.name]; }
  }
  const root = path.join(__dirname, '..');
  const customRequire = (name) => {
    if (name === 'express') return express;
    if (name === 'fs') return { existsSync: () => false, watch() {} };
    if (name === './act-client') return { ActClient };
    if (name === './ems-client') return { EmsClient: class {} };
    if (name === './entitlement-form-data') return { loadFormData: () => ({}) };
    if (name.startsWith('./')) return require(path.join(root, name));
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), {
    require: customRequire, __dirname: root,
    process: { env: { EMS_URL: 'https://ems.example', EMS_USER: 'test', EMS_PASS: 'test' } }, console,
  });
  const res = () => ({
    statusCode: 200,
    cookie(name, value) { this.name = name; this.value = value; },
    clearCookie() {},
    set() { return this; },
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  });
  const alice = res(), bob = res();
  await routes.get('POST /api/act/login')({ headers: {}, body: { username: 'alice', password: 'x' } }, alice);
  await routes.get('POST /api/act/login')({ headers: {}, body: { username: 'bob', password: 'x' } }, bob);
  const listAlice = res(), listBob = res();
  await routes.get('GET /api/act/companies')(request(alice), listAlice);
  await routes.get('GET /api/act/companies')(request(bob), listBob);
  assert.deepEqual(listAlice.body, ['alice']);
  assert.deepEqual(listBob.body, ['bob']);
  await routes.get('POST /api/act/logout')(request(alice), res());
  const after = res();
  await routes.get('GET /api/act/companies')(request(alice), after);
  assert.equal(after.statusCode, 401);
  const stillBob = res();
  await routes.get('GET /api/act/companies')(request(bob), stillBob);
  assert.deepEqual(stillBob.body, ['bob']);
});
