const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('entitlements list links to the separate create form page', () => {
  const dir = path.join(__dirname, '..', 'public');
  const list = fs.readFileSync(path.join(dir, 'entitlements.html'), 'utf8');
  const script = fs.readFileSync(path.join(dir, 'pages', 'entitlements.js'), 'utf8');
  let definition;
  let target;
  vm.runInNewContext(script, {
    fetch: async () => ({ ok: true, json: async () => [] }),
    window: { location: { assign: (url) => { target = url; }, search: '' } },
    URLSearchParams,
    Vue: { createApp: (options) => { definition = options; return { mount() {} }; } },
  });
  definition.methods.openCreateEntitlement();
  assert.equal(target, '/create-entitlement-form.html');
  assert.doesNotMatch(list, /class="entitlement-form"|<legend>/);
  assert.ok(fs.existsSync(path.join(dir, 'create-entitlement-form.html')));
});

test('shared head, disclaimer and nav are included into pages with the right current link', () => {
  const { renderPage } = require('../src/page-includes');
  const dir = path.join(__dirname, '..');
  const render = (file, route, isTestMode = false) => renderPage(fs.readFileSync(path.join(dir, 'public', file), 'utf8'), path.join(dir, 'partials'), route, isTestMode);
  const entitlements = render('entitlements.html', '/entitlements.html');
  assert.doesNotMatch(entitlements, /<!-- include:/);
  assert.match(entitlements, /<link rel="stylesheet" href="\/styles.css">\s*<script src="\/theme.js"><\/script>/);
  assert.match(entitlements, /class="dev-disclaimer">! WARNING: This is the Production EMS !<\/div>/);
  assert.match(entitlements, /<a href="\/entitlements.html" aria-current="page">Entitlements<\/a>\s*<a href="\/activations.html">Product Keys<\/a>\s*<a href="\/">Customers<\/a>/);
  const activations = render('activations.html', '/activations.html');
  assert.match(activations, /<a href="\/activations.html" aria-current="page">Product Keys<\/a>/);
  assert.match(activations, /Key Details/);
  assert.match(render('index.html', '/'), /<a href="\/entitlements.html">Entitlements<\/a>\s*<a href="\/activations.html">Product Keys<\/a>\s*<a href="\/" aria-current="page">Customers<\/a>/);
  for (const [file, route] of [['login.html', '/login.html'], ['entitlements.html', '/entitlements.html'], ['404.html', '/404.html']]) {
    assert.match(render(file, route, true), /! WARNING: This is the Test EMS !/);
    assert.match(render(file, route, false), /! WARNING: This is the Production EMS !/);
  }
});

