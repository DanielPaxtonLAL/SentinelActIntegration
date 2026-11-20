const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { TextEncoder, TextDecoder } = require('node:util');
const { Worker } = require('node:worker_threads');

const root = path.join(__dirname, '..');
const cryptoScript = fs.readFileSync(path.join(root, 'public', 'login-credentials.js'), 'utf8');
const workerFile = path.join(root, 'public', 'login-crypto-worker.js');
const loginScript = fs.readFileSync(path.join(root, 'public', 'pages', 'login.js'), 'utf8');

function context(extra = {}) {
  const sandbox = { crypto: webcrypto, TextEncoder, TextDecoder, btoa, atob, ...extra };
  vm.createContext(sandbox);
  vm.runInContext(cryptoScript, sandbox);
  return sandbox;
}

class BrowserWorker {
  constructor() {
    this.worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const fs = require('node:fs');
      const vm = require('node:vm');
      const sandbox = { Uint8Array, ArrayBuffer, setTimeout, clearTimeout, addEventListener() {},
        postMessage: (data) => parentPort.postMessage(data) };
      sandbox.self = sandbox;
      vm.createContext(sandbox);
      sandbox.importScripts = () => vm.runInContext(
        fs.readFileSync(require.resolve('node-forge/dist/forge.min.js'), 'utf8'), sandbox
      );
      vm.runInContext(fs.readFileSync(workerData, 'utf8'), sandbox);
      parentPort.on('message', (data) => sandbox.onmessage({ data }));
    `, { eval: true, workerData: workerFile });
    this.worker.on('message', (data) => this.onmessage({ data }));
    this.worker.on('error', () => this.onerror());
  }
  postMessage(data) { this.worker.postMessage(data); }
  terminate() { this.worker.terminate(); }
}

test('credentials are encrypted with a unique salt and authenticated against password and username', async () => {
  const { loginCredentials } = context();
  const credentials = { username: 'act-user', password: 'act-secret' };
  const first = await loginCredentials.encrypt('ems-user', 'ems-secret', credentials);
  const second = await loginCredentials.encrypt('ems-user', 'ems-secret', credentials);
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /act-user|act-secret|ems-secret/);
  assert.deepEqual(JSON.parse(JSON.stringify(await loginCredentials.decrypt('ems-user', 'ems-secret', first))), credentials);
  await assert.rejects(() => loginCredentials.decrypt('ems-user', 'wrong', first));
  await assert.rejects(() => loginCredentials.decrypt('other-user', 'ems-secret', first));
  const tampered = JSON.parse(first);
  tampered.ciphertext = tampered.ciphertext.replace(/^./, tampered.ciphertext[0] === 'A' ? 'B' : 'A');
  await assert.rejects(() => loginCredentials.decrypt('ems-user', 'ems-secret', JSON.stringify(tampered)));
});

test('HTTP worker encryption is compatible with Web Crypto and rejects wrong passwords', async () => {
  const secure = context().loginCredentials;
  const http = context({
    crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
    Worker: BrowserWorker,
  }).loginCredentials;
  const credentials = { username: 'act-user-\u00e9', password: 'act-secret-\u00e9' };
  const fromHttp = await http.encrypt('ems-\u00e9', 'password-\u00e9', credentials);
  assert.doesNotMatch(fromHttp, /act-user|act-secret|password/);
  assert.deepEqual(JSON.parse(JSON.stringify(await secure.decrypt('ems-\u00e9', 'password-\u00e9', fromHttp))), credentials);
  const fromSecure = await secure.encrypt('ems-\u00e9', 'password-\u00e9', credentials);
  assert.deepEqual(JSON.parse(JSON.stringify(await http.decrypt('ems-\u00e9', 'password-\u00e9', fromSecure))), credentials);
  await assert.rejects(() => http.decrypt('ems-\u00e9', 'wrong', fromSecure));
});

function loginPage(storage, loginResult = { ok: true }, overrides = {}, emsMode = 'production') {
  const elements = {};
  const create = () => ({
    value: '', hidden: false, disabled: false, textContent: '',
    classList: {
      values: new Set(),
      add(name) { this.values.add(name); },
      remove(name) { this.values.delete(name); },
      toggle(name, force) { if (force) this.values.add(name); else this.values.delete(name); },
      contains(name) { return this.values.has(name); },
    },
    setAttribute() {},
    addEventListener(name, callback) { this[name] = callback; },
  });
  for (const id of ['loginForm', 'submitButton', 'status', 'configureButton', 'actCredentials', 'continueLink', 'savedActHint']) {
    elements[id] = create();
  }
  elements.actCredentials.hidden = elements.continueLink.hidden = true;
  elements.loginForm.elements = Object.fromEntries(
    ['username', 'password', 'actUsername', 'actPassword'].map((name) => [name, create()])
  );
  const requests = [];
  const redirects = [];
  const sandbox = context({
    document: { querySelector(selector) { return elements[selector.slice(1)]; } },
    window: { location: { replace(value) { redirects.push(value); } } },
    localStorage: storage,
    FormData: class {
      constructor(form) { this.form = form; }
      get(name) { return this.form.elements[name].value; }
    },
    async fetch(url, options) {
      if (url === '/api/session') return { ok: true, async json() { return { authenticated: false, emsMode }; } };
      requests.push(JSON.parse(options.body));
      return { ok: loginResult.ok, async json() { return loginResult.ok ? { ok: true } : { error: 'Rejected' }; } };
    },
    ...overrides,
  });

  vm.runInContext(loginScript, sandbox);
  return { elements, requests, redirects, ready: vm.runInContext('sessionReady', sandbox) };
}

test('configuration is understated only when saved credentials exist for the entered EMS username', async () => {
  const page = loginPage({ getItem(key) { return key === 'act-credentials:v2:production:alice' ? 'encrypted' : null; } });
  await page.ready;
  const username = page.elements.loginForm.elements.username;
  const configure = page.elements.configureButton;
  const hint = page.elements.savedActHint;
  assert.equal(configure.textContent, 'Configure Act! login');
  assert.equal(hint.hidden, true);

  username.value = 'alice';
  username.input();
  assert.equal(configure.textContent, 'Change saved Act! login');
  assert.equal(configure.classList.contains('login-configure-saved'), true);
  assert.equal(hint.hidden, false);

  configure.click();
  assert.equal(configure.textContent, 'Use saved Act! login');
  assert.equal(configure.classList.contains('login-configure-saved'), false);
  assert.equal(hint.hidden, true);
  configure.click();

  username.value = 'bob';
  username.change();
  assert.equal(configure.textContent, 'Configure Act! login');
  assert.equal(configure.classList.contains('login-configure-saved'), false);
  assert.equal(hint.hidden, true);
});

test('login page configures and unlocks saved credentials without Web Crypto', async () => {
  const records = new Map();
  const storage = {
    getItem(key) { return records.get(key) ?? null; },
    setItem(key, value) { records.set(key, value); },
  };
  const overrides = { crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }, Worker: BrowserWorker };
  const first = loginPage(storage, { ok: true }, overrides);
  const form = first.elements.loginForm;
  form.elements.username.value = 'ems-user';
  form.elements.password.value = 'ems-secret';
  first.elements.configureButton.click();
  form.elements.actUsername.value = 'act-user';
  form.elements.actPassword.value = 'act-secret';
  await form.submit({ preventDefault() {} });
  assert.deepEqual(first.redirects, ['/']);
  assert.doesNotMatch(records.get('act-credentials:v2:production:ems-user'), /act-user|act-secret|ems-secret/);
  const later = loginPage(storage, { ok: true }, overrides);
  later.elements.loginForm.elements.username.value = 'ems-user';
  later.elements.loginForm.elements.password.value = 'ems-secret';
  await later.elements.loginForm.submit({ preventDefault() {} });
  assert.deepEqual(later.requests[0], first.requests[0]);
});

test('first login saves only ciphertext and later login unlocks it without re-entering Act credentials', async () => {
  const records = new Map();
  const storage = {
    getItem(key) { return records.get(key) ?? null; },
    setItem(key, value) { records.set(key, value); },
  };
  const first = loginPage(storage);
  const form = first.elements.loginForm;
  form.elements.username.value = 'ems-user';
  form.elements.password.value = 'ems-secret';
  first.elements.configureButton.click();
  form.elements.actUsername.value = 'act-user';
  form.elements.actPassword.value = 'act-secret';
  await form.submit({ preventDefault() {} });
  assert.deepEqual(first.requests[0], {
    username: 'ems-user', password: 'ems-secret', actUsername: 'act-user', actPassword: 'act-secret', emsMode: 'production',
  });
  assert.deepEqual(first.redirects, ['/']);
  const saved = records.get('act-credentials:v2:production:ems-user');
  assert.doesNotMatch(saved, /ems-secret|act-user|act-secret/);
  assert.equal(form.elements.password.value, '');
  assert.equal(form.elements.actPassword.value, '');

  const later = loginPage(storage);
  later.elements.loginForm.elements.username.value = 'ems-user';
  later.elements.loginForm.elements.password.value = 'ems-secret';
  await later.elements.loginForm.submit({ preventDefault() {} });
  assert.deepEqual(later.requests[0], first.requests[0]);
  assert.deepEqual(later.redirects, ['/']);

  const wrong = loginPage(storage);
  wrong.elements.loginForm.elements.username.value = 'ems-user';
  wrong.elements.loginForm.elements.password.value = 'wrong';
  await wrong.elements.loginForm.submit({ preventDefault() {} });
  assert.equal(wrong.requests.length, 0);
  assert.match(wrong.elements.status.textContent, /Could not unlock/);
  assert.equal(records.get('act-credentials:v2:production:ems-user'), saved);
});

test('production credentials migrate and remain separate from test credentials', async () => {
  const old = await context().loginCredentials.encrypt('same-user', 'ems-secret', {
    username: 'production-act', password: 'production-secret',
  });
  const records = new Map([['act-credentials:v1:same-user', old]]);
  const storage = {
    getItem(key) { return records.get(key) ?? null; },
    setItem(key, value) { records.set(key, value); },
  };
  const production = loginPage(storage);
  production.elements.loginForm.elements.username.value = 'same-user';
  production.elements.loginForm.elements.password.value = 'ems-secret';
  await production.elements.loginForm.submit({ preventDefault() {} });
  assert.equal(production.requests[0].actUsername, 'production-act');
  assert.equal(records.get('act-credentials:v2:production:same-user'), old);

  const testing = loginPage(storage, { ok: true }, {}, 'test');
  testing.elements.loginForm.elements.username.value = 'same-user';
  testing.elements.loginForm.elements.password.value = 'ems-secret';
  await testing.elements.loginForm.submit({ preventDefault() {} });
  assert.equal(testing.requests.length, 0);
  assert.equal(testing.elements.actCredentials.hidden, false);
  testing.elements.loginForm.elements.password.value = 'ems-secret';
  testing.elements.loginForm.elements.actUsername.value = 'test-act';
  testing.elements.loginForm.elements.actPassword.value = 'test-secret';
  await testing.elements.loginForm.submit({ preventDefault() {} });
  assert.equal(testing.requests[0].actUsername, 'test-act');
  assert.equal(testing.requests[0].emsMode, 'test');
  assert.notEqual(records.get('act-credentials:v2:test:same-user'), old);
  assert.equal(records.get('act-credentials:v2:production:same-user'), old);
});

test('failed login does not overwrite previously saved credentials', async () => {
  const records = new Map([['act-credentials:v1:ems-user', 'old-ciphertext']]);
  const page = loginPage({
    getItem(key) { return records.get(key); },
    setItem(key, value) { records.set(key, value); },
  }, { ok: false });
  const form = page.elements.loginForm;
  form.elements.username.value = 'ems-user';
  form.elements.password.value = 'ems-secret';
  page.elements.configureButton.click();
  form.elements.actUsername.value = 'new-act-user';
  form.elements.actPassword.value = 'new-act-secret';
  await form.submit({ preventDefault() {} });
  assert.equal(records.get('act-credentials:v1:ems-user'), 'old-ciphertext');
  assert.match(page.elements.status.textContent, /Rejected/);
  assert.equal(form.elements.actPassword.value, '');
});

test('missing credentials open setup and a storage failure is reported after login', async () => {
  const page = loginPage({
    getItem() { return null; },
    setItem() { throw new Error('Storage unavailable'); },
  });
  const form = page.elements.loginForm;
  form.elements.username.value = 'ems-user';
  form.elements.password.value = 'ems-secret';
  await form.submit({ preventDefault() {} });
  assert.equal(page.requests.length, 0);
  assert.equal(page.elements.actCredentials.hidden, false);
  assert.match(page.elements.status.textContent, /No Act! login is saved/);

  form.elements.password.value = 'ems-secret';
  form.elements.actUsername.value = 'act-user';
  form.elements.actPassword.value = 'act-secret';
  await form.submit({ preventDefault() {} });
  assert.equal(page.requests.length, 1);
  assert.match(page.elements.status.textContent, /could not save/);
  assert.equal(page.elements.continueLink.hidden, false);
  assert.equal(form.elements.actPassword.value, '');
});
