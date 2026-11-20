const test = require('node:test');
const assert = require('node:assert/strict');
const { loadEnvironmentFile } = require('../src/environment');

test('loads quoted and unquoted values without overriding existing environment', () => {
  const env = { KEEP: 'process-value', EMPTY: '' };
  const fileSystem = {
    existsSync: () => true,
    readFileSync: () => [
      '# comment',
      'KEEP=file-value',
      'EMPTY=not-empty',
      ' QUOTED = "hello world" ',
      "SINGLE='value'",
      'EQUALS=a=b',
      'MODE=false # production',
      'QUOTED_HASH="value # kept" # comment',
      "SINGLE_HASH='value # kept' # comment",
      'URL=https://example.test/path#fragment',
      'IGNORED LINE',
    ].join('\r\n'),
  };
  loadEnvironmentFile('unused', env, fileSystem);
  assert.deepEqual(env, {
    KEEP: 'process-value',
    EMPTY: '',
    QUOTED: 'hello world',
    SINGLE: 'value',
    EQUALS: 'a=b',
    MODE: 'false',
    QUOTED_HASH: 'value # kept',
    SINGLE_HASH: 'value # kept',
    URL: 'https://example.test/path#fragment',
  });
});

test('leaves the environment unchanged when the file is absent', () => {
  const env = { KEEP: 'value' };
  loadEnvironmentFile('missing', env, {
    existsSync: () => false,
    readFileSync: () => { throw new Error('unexpected read'); },
  });
  assert.deepEqual(env, { KEEP: 'value' });
});
