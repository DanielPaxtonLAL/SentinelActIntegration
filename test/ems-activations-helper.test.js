const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const python = process.env.PYTHON || 'python';
const hasPython = spawnSync(python, ['--version'], { stdio: 'ignore' }).status === 0;
const script = path.join(__dirname, '..', 'config-helper-scripts', 'get-ems-activations.py');

test('activation helper parses dotenv inline comments', { skip: !hasPython }, () => {
  const code = `
import importlib.util
spec = importlib.util.spec_from_file_location("helper", ${JSON.stringify(script).replaceAll('\\', '\\\\')})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.parse_dotenv_line("IS_TEST_MODE=true # Default setting") == ("IS_TEST_MODE", "true")
assert module.parse_dotenv_line("TEST_EMS_URL=http://ems.example:8080 # Test server") == ("TEST_EMS_URL", "http://ems.example:8080")
assert module.parse_dotenv_line('ACT_DATABASE="Irricad # North"') == ("ACT_DATABASE", "Irricad # North")
`;
  const result = spawnSync(python, ['-c', code], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
});

function runHelper(url, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const args = url ? [script, url] : [script];
    const child = spawn(python, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
      env: { ...process.env, ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end('test-user\ntest-password\n');
  });
}

test('activation helper prints report and complete activation XML across entitlement pages', { skip: !hasPython }, async () => {
  const paths = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url);
    if (req.url === '/ems/login.html') {
      res.setHeader('Set-Cookie', 'JSESSIONID=mock; Path=/ems');
      res.end('login');
    } else if (req.url === '/ems/verifyLogin.html') {
      res.writeHead(302, { Location: '/ems/homePage' });
      res.end();
    } else if (req.url === '/ems/homePage') {
      res.end('home');
    } else if (req.url === '/ems/v90/ws/report/CustomerActivationReport.ws?format=csv') {
      res.end('Customer,Product\nExample,Base\n');
    } else if (req.url.startsWith('/ems/v90/ws/entitlement.ws?')) {
      res.setHeader('X-Total-Count', '2');
      const id = new URL(req.url, 'http://localhost').searchParams.get('pageIndex');
      res.end(`<listResponse><instance id="${id}"/></listResponse>`);
    } else if (req.url === '/ems/v90/ws/entitlement/1.ws') {
      res.end('<entitlement><entState>COMPLETED</entState><entitlementItem><lineItemType>Product_Key</lineItemType><productKeyId>key-1</productKeyId></entitlementItem></entitlement>');
    } else if (req.url === '/ems/v90/ws/entitlement/2.ws') {
      res.end('<entitlement><entState>PRODUCT_KEY_GENERATED</entState><entitlementItem><lineItemType>Product_Key</lineItemType><productKeyId>key-2</productKeyId></entitlementItem></entitlement>');
    } else if (req.url === '/ems/v90/ws/productKey/key-1.ws') {
      res.end('<productKey><productKeyId>key-1</productKeyId><entitlementId>1</entitlementId><activation AID="aid-1"/></productKey>');
    } else if (req.url === '/ems/v90/ws/productKey/key-2.ws') {
      res.end('<productKey><productKeyId>key-2</productKeyId><entitlementId>2</entitlementId><available>0</available></productKey>');
    } else if (req.url === '/ems/v90/ws/activation/aid-1.ws') {
      res.end('<activation><activationOutput><AID>aid-1</AID><activationString>license</activationString></activationOutput><activationInput><comments>example comment</comments></activationInput></activation>');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const result = await runHelper(null, {
      TEST_EMS_URL: baseUrl,
      TEST_EMS_API_VERSION: 'v90',
      TEST_EMS_USER_TYPE: 'ISV',
      TEST_EMS_INSECURE: '0',
      IS_TEST_MODE: 'true',
      EMS_USER: 'test-user',
      EMS_PASS: 'test-password',
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Customer,Product\s+Example,Base/);
    assert.match(result.stdout, /<activationString>license<\/activationString>/);
    assert.match(result.stdout, /<comments>example comment<\/comments>/);
    assert.match(result.stdout, /<productKeyId>key-2<\/productKeyId>/);
    assert.match(result.stderr, /1 product key item\(s\) had no activation ID/);
    assert.ok(paths.some((url) => url.includes('pageIndex=2')));
    assert.equal(paths.filter((url) => url === '/ems/v90/ws/activation/aid-1.ws').length, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /test-password/);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test('activation helper reports incomplete paging instead of claiming success', { skip: !hasPython }, async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/ems/login.html') {
      res.setHeader('Set-Cookie', 'JSESSIONID=mock; Path=/ems');
      res.end('login');
    } else if (req.url === '/ems/verifyLogin.html') {
      res.writeHead(302, { Location: '/ems/homePage' });
      res.end();
    } else if (req.url === '/ems/homePage') {
      res.end('home');
    } else if (req.url.includes('CustomerActivationReport')) {
      res.end('Customer,Product\n');
    } else {
      res.end('<listResponse/>');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await runHelper(`http://127.0.0.1:${server.address().port}`);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /X-Total-Count/);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
