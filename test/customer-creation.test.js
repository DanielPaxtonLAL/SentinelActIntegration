const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function customerRoute() {
  let handler;
  let saved;
  class ActClient {
    constructor() { this.token = 'test'; }
    async authenticate() {}
    async getCompany(id) {
      return id === 'parent'
        ? { id, name: ' Adrictec ' }
        : { id, name: id === 'division' ? ' Jordon ' : ' Standalone ', hasDivisions: false };
    }
    async getCompanyDivisions(id) {
      return id === 'parent' ? [{ id: 'division' }] : [];
    }
  }
  class EmsClient {
    constructor() { this.authenticated = true; }
    async listCustomers() { return []; }
    async createCustomer(data) { saved = data; return '/customer/1'; }
  }
  const app = {
    get() {},
    post(route, ...handlers) {
      if (route === '/api/act/companies/:id/add-to-ems') handler = handlers.at(-1);
    },
    put() {},
    delete() {},
    use() {},
    listen() {},
  };
  const express = () => app;
  express.static = () => {};
  express.json = () => {};
  const root = path.join(__dirname, '..');
  const customRequire = (name) => {
    if (name === 'express') return express;
    if (name === 'fs') return { existsSync: () => false, watch() {} };
    if (name === './ems-client') return { EmsClient };
    if (name === './act-client') return { ActClient };
    if (name === './act-sessions') return { createActSessions: (factory) => ({ get: () => factory(), remove() {} }) };
    if (name === './entitlement-form-data') return { loadFormData: () => ({}) };
    if (name.startsWith('./')) return require(path.join(root, name));
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'server.js'), 'utf8'), {
    require: customRequire,
    __dirname: root,
    process: { env: { EMS_URL: 'https://ems.example', ACT_URL: 'https://act.example' } },
    console,
  });
  return async (id, parentId) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(data) { this.body = data; return this; },
    };
    await handler({ params: { id }, body: { parentId }, ems: new EmsClient(), integrationSession: { act: new ActClient() } }, res);
    return { res, saved };
  };
}

test('creates division customers with a separator and keeps standalone names unchanged', async () => {
  const submit = customerRoute();
  const division = await submit('division', 'parent');
  assert.equal(division.res.statusCode, 201);
  assert.equal(division.saved.name, 'Adrictec - Jordon');
  const standalone = await submit('standalone');
  assert.equal(standalone.res.statusCode, 201);
  assert.equal(standalone.saved.name, 'Standalone');
});
