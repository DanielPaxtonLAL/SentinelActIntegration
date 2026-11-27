const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const forge = require('node-forge');

const execFileAsync = promisify(execFile);

test('product helper reads dotenv inline comments and quoted values', { skip: process.platform !== 'win32' }, async () => {
  let credentials;
  const server = http.createServer((req, res) => {
    if (req.url === '/ems/login.html') {
      res.setHeader('Set-Cookie', 'JSESSIONID=mock; Path=/ems');
      res.end('login');
    } else if (req.url === '/ems/verifyLogin.html') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        credentials = new URLSearchParams(body);
        res.writeHead(302, { Location: '/ems/homePage' });
        res.end();
      });
    } else if (req.url === '/ems/homePage') {
      res.end('home');
    } else if (req.url.startsWith('/ems/v91/ws/vendor/2/product.ws?')) {
      res.setHeader('Content-Type', 'application/xml');
      res.end('<listResponse><instance id="42" name="Mock product"/></listResponse>');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ems-products-test-'));
  const helperDir = path.join(root, 'config-helper-scripts');
  const helper = path.join(helperDir, 'get-ems-products.ps1');
  const envFile = path.join(root, '.env');
  try {
    await fs.mkdir(helperDir);
    await fs.copyFile(path.join(__dirname, '..', 'config-helper-scripts', 'get-ems-products.ps1'), helper);
    const url = `http://127.0.0.1:${server.address().port}`;
    await fs.writeFile(envFile, [
      `PRODUCTION_EMS_URL=${url} # The base URL for the production EMS environment`,
      'TEST_EMS_URL="http://other.example" # Test server',
      'PRODUCTION_EMS_API_VERSION=v91 # API version',
      'PRODUCTION_EMS_USER_TYPE=ISV # User type',
      'EMS_USER="test # user" # Username',
      "EMS_PASS='test # password' # Password",
      'EMS_VENDOR_ID=2 # Vendor',
    ].join('\n'));
    const env = { ...process.env };
    for (const name of ['PRODUCTION_EMS_URL', 'TEST_EMS_URL', 'PRODUCTION_EMS_API_VERSION',
      'PRODUCTION_EMS_USER_TYPE', 'PRODUCTION_EMS_INSECURE', 'EMS_USER', 'EMS_PASS', 'EMS_VENDOR_ID']) delete env[name];
    const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', helper, url], { env, timeout: 30000 });
    assert.match(result.stdout, /Mock product/);
    assert.equal(credentials.get('username'), 'test # user');
    assert.equal(credentials.get('password'), 'test # password');
    assert.equal(credentials.get('user_type'), 'ISV');
    assert.doesNotMatch(result.stdout + result.stderr, /test # password/);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    await fs.unlink(envFile);
    await fs.unlink(helper);
    await fs.rmdir(helperDir);
    await fs.rmdir(root);
  }
});

test('product helper opts into invalid EMS certificates and restores PowerShell TLS settings', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows PowerShell 5.1 is required for this test');
    return;
  }
  const keys = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = forge.pki.publicKeyFromPem(keys.publicKey);
  certificate.serialNumber = '01';
  certificate.validity.notBefore = new Date(Date.now() - 60000);
  certificate.validity.notAfter = new Date(Date.now() + 3600000);
  certificate.setSubject([{ name: 'commonName', value: 'localhost' }]);
  certificate.setIssuer([{ name: 'commonName', value: 'localhost' }]);
  certificate.sign(forge.pki.privateKeyFromPem(keys.privateKey), forge.md.sha256.create());

  const connections = [];
  let userType;
  const server = https.createServer({ key: keys.privateKey, cert: forge.pki.certificateToPem(certificate) }, (req, res) => {
    connections.push(req.headers.connection);
    if (req.url === '/ems/login.html') {
      res.setHeader('Set-Cookie', 'JSESSIONID=mock; Path=/ems');
      res.end('login');
    } else if (req.url === '/ems/verifyLogin.html') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        userType = new URLSearchParams(body).get('user_type');
        res.writeHead(302, { Location: '/ems/homePage' });
        res.end();
      });
    } else if (req.url === '/ems/homePage') {
      res.end('home');
    } else if (req.url.startsWith('/ems/v91/ws/vendor/2/product.ws?')) {
      res.setHeader('Content-Type', 'application/xml');
      res.end('<listResponse><instance id="42" name="Mock product"/></listResponse>');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const helper = path.join(__dirname, '..', 'config-helper-scripts', 'get-ems-products.ps1').replace(/'/g, "''");
    const url = `https://127.0.0.1:${server.address().port}`;
    const env = {
      ...process.env, EMS_USER: 'test-user', EMS_PASS: 'test-password', EMS_USER_TYPE: 'ISV',
      EMS_API_VERSION: 'v90', EMS_INSECURE: '1', EMS_VENDOR_ID: '2', IS_TEST_MODE: 'true',
      PRODUCTION_EMS_URL: url, PRODUCTION_EMS_API_VERSION: 'v91', PRODUCTION_EMS_USER_TYPE: 'CUSTOMER',
      TEST_EMS_URL: 'https://other.example', TEST_EMS_INSECURE: '0',
    };
    const command = `$before = [Net.ServicePointManager]::ServerCertificateValidationCallback; ` +
      `& '${helper}' '${url}'; ` +
      `if ([Net.ServicePointManager]::ServerCertificateValidationCallback -ne $before) { throw 'TLS callback not restored' }`;
    await assert.rejects(() => execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      env: { ...env, PRODUCTION_EMS_INSECURE: '0' }, timeout: 30000,
    }));
    const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      env: { ...env, PRODUCTION_EMS_INSECURE: '1' }, timeout: 30000,
    });
    assert.match(result.stdout, /EMS insecure mode disables certificate verification for EMS requests/);
    assert.match(result.stdout, /Mock product/);
    assert.equal(userType, 'CUSTOMER');
    assert.ok(connections.length > 0);
    assert.ok(connections.every((connection) => connection?.toLowerCase() === 'close'));
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
