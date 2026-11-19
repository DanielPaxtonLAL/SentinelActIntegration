const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const forge = require('node-forge');

const execFileAsync = promisify(execFile);

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
  const server = https.createServer({ key: keys.privateKey, cert: forge.pki.certificateToPem(certificate) }, (req, res) => {
    connections.push(req.headers.connection);
    if (req.url === '/ems/login.html') {
      res.setHeader('Set-Cookie', 'JSESSIONID=mock; Path=/ems');
      res.end('login');
    } else if (req.url === '/ems/verifyLogin.html') {
      res.writeHead(302, { Location: '/ems/homePage' });
      res.end();
    } else if (req.url === '/ems/homePage') {
      res.end('home');
    } else if (req.url.startsWith('/ems/v90/ws/vendor/2/product.ws?')) {
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
      EMS_API_VERSION: 'v90', EMS_VENDOR_ID: '2',
    };
    const command = `$before = [Net.ServicePointManager]::ServerCertificateValidationCallback; ` +
      `& '${helper}' '${url}'; ` +
      `if ([Net.ServicePointManager]::ServerCertificateValidationCallback -ne $before) { throw 'TLS callback not restored' }`;
    await assert.rejects(() => execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      env: { ...env, EMS_INSECURE: '0' }, timeout: 30000,
    }));
    const result = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      env: { ...env, EMS_INSECURE: '1' }, timeout: 30000,
    });
    assert.match(result.stdout, /EMS_INSECURE=1 disables certificate verification for EMS requests/);
    assert.match(result.stdout, /Mock product/);
    assert.ok(connections.length > 0);
    assert.ok(connections.every((connection) => connection?.toLowerCase() === 'close'));
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
