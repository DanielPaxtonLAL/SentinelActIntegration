const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'theme.js'), 'utf8');

function createThemeHarness(initialTheme) {
  let storedTheme = initialTheme;
  let onReady;
  let onClick;
  const attributes = {};
  const toggle = {
    setAttribute(name, value) {
      attributes[name] = value;
    },
    addEventListener(name, callback) {
      if (name === 'click') onClick = callback;
    },
  };
  const logout = {
    textContent: 'Log out',
    before(button) {
      assert.equal(button, toggle);
    },
  };
  const root = {
    getAttribute(name) {
      return attributes[name];
    },
    setAttribute(name, value) {
      attributes[name] = value;
    },
  };

  vm.runInNewContext(source, {
    document: {
      documentElement: root,
      addEventListener(name, callback) {
        if (name === 'DOMContentLoaded') onReady = callback;
      },
      createElement() {
        return toggle;
      },
      querySelectorAll() {
        return [logout];
      },
    },
    localStorage: {
      getItem() {
        return storedTheme;
      },
      setItem(key, value) {
        storedTheme = value;
      },
    },
    matchMedia() {
      return { matches: false };
    },
  });
  onReady();

  return {
    attributes,
    toggle,
    click() {
      onClick();
    },
    storedTheme() {
      return storedTheme;
    },
  };
}

test('theme button cycles through all themes and saves the choice', () => {
  const app = createThemeHarness('light');
  assert.equal(app.toggle.textContent, 'Dark theme');
  app.click();
  assert.equal(app.attributes['data-theme'], 'dark');
  assert.equal(app.storedTheme(), 'dark');
  assert.equal(app.toggle.textContent, 'Dracula theme');
  app.click();
  assert.equal(app.attributes['data-theme'], 'dracula');
  assert.equal(app.storedTheme(), 'dracula');
  assert.equal(app.toggle.textContent, 'Fugly theme');
  app.click();
  assert.equal(app.attributes['data-theme'], 'fugly');
  assert.equal(app.storedTheme(), 'fugly');
  assert.equal(app.toggle.textContent, 'Light theme');
  app.click();
  assert.equal(app.attributes['data-theme'], 'light');
});

test('saved alternate themes are restored', () => {
  for (const theme of ['dracula', 'fugly']) {
    const app = createThemeHarness(theme);
    assert.equal(app.attributes['data-theme'], theme);
    assert.equal(app.toggle.textContent, theme === 'dracula' ? 'Fugly theme' : 'Light theme');
  }
});
