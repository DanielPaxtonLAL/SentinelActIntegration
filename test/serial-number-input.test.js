const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'serial-number-input.js'), 'utf8');
const component = vm.runInNewContext(`${source}\nSerialNumberInput`);

function createInput(value = '', maxDigits = 5) {
  const inputs = Array.from({ length: Math.max(5, maxDigits, value.length) }, (_, index) => ({
    focus() { state.focused = index; },
    setCustomValidity(message) { state.validity = message; },
  }));
  const state = {
    ...component.methods,
    ...component.data(),
    modelValue: value,
    maxDigits,
    $refs: { digits: inputs },
    $nextTick(callback) { callback(); },
    $emit(_event, next) { this.modelValue = next; },
  };
  Object.defineProperty(state, 'digitCount', { get: () => component.computed.digitCount.call(state) });
  return state;
}

function key(state, index, value) {
  let prevented = false;
  state.onKeydown({ key: value, preventDefault() { prevented = true; } }, index);
  assert.equal(prevented, true);
}

function paste(state, index, text) {
  state.onPaste({ preventDefault() {}, clipboardData: { getData: () => text } }, index);
}

test('digits advance sequentially, can be replaced, and backspace removes digits', () => {
  const state = createInput();
  for (const [index, digit] of Array.from('65536').entries()) key(state, index, digit);
  assert.equal(state.modelValue, '65536');
  assert.equal(state.focused, 4);
  key(state, 4, '0');
  assert.equal(state.modelValue, '65536');
  assert.match(state.validity, /no more than 5 digits/);
  key(state, 4, 'Backspace');
  assert.equal(state.modelValue, '6553');
  assert.equal(state.validity, '');
  key(state, 2, '9');
  assert.equal(state.modelValue, '6593');
  assert.equal(state.focused, 3);
  key(state, 4, 'Backspace');
  assert.equal(state.modelValue, '659');
  assert.equal(state.focused, 3);
});

test('pasting fills boxes and rejects excess or nonnumeric input without changing the value', () => {
  const state = createInput();
  paste(state, 0, '65,536');
  assert.equal(state.modelValue, '65536');
  assert.equal(state.focused, 4);
  paste(state, 0, '123456');
  assert.equal(state.modelValue, '65536');
  assert.match(state.validity, /no more than 5 digits/);
  paste(state, 0, '12x');
  assert.match(state.validity, /digits only/);
  paste(state, 0, '12345');
  assert.equal(state.modelValue, '12345');
  assert.equal(state.validity, '');
});

test('uses additional boxes when the configured capacity or existing value needs them', () => {
  assert.equal(createInput().digitCount, 5);
  assert.equal(createInput('', 8).digitCount, 8);
  assert.equal(createInput('123456').digitCount, 6);
});
