const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const forge = require('node-forge');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

test('PowerShell helper prompts and lists distinct protection keys in serial order', {
  skip: process.platform !== 'win32',
}, async () => {
  let badSerial = false;
  let conflicting = false;
  let noUpdates = false;
  let missingCounter = false;
  let largeSerials = false;
  let slowLogin = false;
  let escapedHistory = false;
  let rejectLogin = false;
  let loginRequest;
  const methods = [];
  const server = http.createServer((req, res) => {
    methods.push([req.method, req.url]);
    if (req.url === '/ems/login.html') {
      if (req.headers.accept !== '*/*') {
        res.writeHead(406);
        res.end();
        return;
      }
      res.setHeader('Set-Cookie', 'JSESSIONID=mock; Path=/ems');
      if (slowLogin) setTimeout(() => res.end('login'), 350);
      else res.end('login');
    } else if (req.url === '/ems/verifyLogin.html') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        loginRequest = { headers: req.headers, fields: new URLSearchParams(body) };
        if (rejectLogin || req.headers.accept !== '*/*' ||
            !req.headers.cookie?.includes('JSESSIONID=mock') ||
            !req.headers['content-type']?.startsWith('application/x-www-form-urlencoded') ||
            loginRequest.fields.get('username') !== 'test-user' ||
            loginRequest.fields.get('password') !== 'test # &+%' ||
            loginRequest.fields.get('user_type') !== 'ISV') {
          res.writeHead(200);
          res.end('login not confirmed');
        } else {
          res.writeHead(302, { Location: '/ems/homePage' });
          res.end();
        }
      });
    } else if (req.url.startsWith('/ems/v90/ws/entitlement.ws?')) {
      res.setHeader('X-Total-Count', '2');
      const page = new URL(req.url, 'http://localhost').searchParams.get('pageIndex');
      res.end(`<listResponse><instance id="${page}"/></listResponse>`);
    } else if (/^\/ems\/v90\/ws\/entitlement\/[12]\.xml$/.test(req.url)) {
      const id = req.url.includes('/1.xml') ? '1' : '2';
      const serial = largeSerials ? (id === '1' ? '3138364130' : '3138363946') :
        id === '1' ? '31373732' : badSerial ? 'invalid' : '31373731';
      res.end(`<entitlement><customerId>${id}</customerId><entitlementItem><lineItemType>Product_Key</lineItemType><productKeyId>key-${id}</productKeyId>${id === '1' ? '<productKeyId>key-3</productKeyId>' : ''}
        <memorySegments><segment><prdMemorySegmentId>91</prdMemorySegmentId><data>${serial}</data></segment></memorySegments>
        <itemProduct><productId>1</productId><product><memorySegment><id>91</id><name>Serial Number</name><saot>true</saot>
        </memorySegment></product></itemProduct></entitlementItem></entitlement>`);
    } else if (req.url === '/ems/v90/ws/entitlement/3.xml') {
      res.end('<entitlement><customerId>3</customerId><entitlementItem><lineItemType>ProtectionKey_Update</lineItemType><productKeyId>update-3</productKeyId></entitlementItem></entitlement>');
    } else if (req.url === '/ems/v90/ws/customer.xml') {
      res.end('<listResponse><instance id="1" name="Original One"/><instance><id>2</id><name>Original Two</name></instance><instance id="3" name="Latest Customer"/></listResponse>');
    } else if (/^\/ems\/v90\/ws\/target\/pk-[12]\/entitlement\.ws$/.test(req.url)) {
      const id = req.url.includes('pk-1') ? '1' : '2';
      const includeUpdate = id === '2' && !noUpdates;
      res.end(`<listResponse count="${includeUpdate ? 2 : 1}"><instance><id>${id}</id></instance>${includeUpdate ? '<instance id="3"/>' : ''}</listResponse>`);
    } else if (req.url.startsWith('/ems/v90/ws/target/pk-2/activation.ws?')) {
      const aid = new URL(req.url, 'http://localhost').searchParams.get('AID');
      const history = `<sentinel_ldk_info><key><id>pk-2</id><update_counter>${aid === 'aid-2' ? '0' : missingCounter ? '2' : '1'}</update_counter></key></sentinel_ldk_info>`;
      res.end(escapedHistory ? `<ProtectionKey><ProtectionKeyOutput><UpdateInfo>${history.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</UpdateInfo></ProtectionKeyOutput></ProtectionKey>` : history);
    } else if (req.url === '/ems/v90/ws/productKey/update-3.ws') {
      res.end('<productKey><productKeyId>update-3</productKeyId><entitlementId>3</entitlementId><AID protectionKeyId="pk-2">aid-3</AID></productKey>');
    } else if (/^\/ems\/v90\/ws\/productKey\/key-[123]\.ws$/.test(req.url)) {
      const key = /key-(\d)/.exec(req.url)[1];
      const id = key === '3' ? '1' : key;
      res.end(`<productKey><productKeyId>key-${key}</productKeyId><entitlementId>${id}</entitlementId>${key === '3' ? '' : `<AID protectionKeyId="pk-${id}">aid-${id}</AID>`}</productKey>`);
    } else if (/^\/ems\/v90\/ws\/activation\/aid-[123]\.ws$/.test(req.url)) {
      const aid = /aid-\d/.exec(req.url)[0];
      const id = aid === 'aid-1' || conflicting ? '1' : '2';
      res.end(`<activation><activationOutput><AID>${aid}</AID><protectionKeyId>pk-${id}</protectionKeyId></activationOutput></activation>`);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ems-key-helper-'));
  const copy = path.join(tempDir, 'get-protection-key-serials.ps1');
  fs.copyFileSync(path.join(__dirname, '..', 'config-helper-scripts', 'get-protection-key-serials.ps1'), copy);
  try {
    const helper = copy.replace(/'/g, "''");
    const url = `http://127.0.0.1:${server.address().port}`;
    const command = `$env:PATH = ''; function Get-Credential { param($Message) [PSCredential]::new('test-user', (ConvertTo-SecureString 'test # &+%' -AsPlainText -Force)) }; $before = [Net.ServicePointManager]::ServerCertificateValidationCallback; & '${helper}' -BaseUrl '${url}'; if ([Net.ServicePointManager]::ServerCertificateValidationCallback -ne $before) { throw 'TLS callback not restored' }`;
    const run = () => execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 30000 });
    const result = await run();
    assert.match(result.stdout, /Serial Number\s+Protection Key ID\s+Current Customer\r?\n-+\s+-+\s+-+/);
    assert.match(result.stdout, /06002\s+pk-1\s+Unavailable[\s\S]*06001\s+pk-2\s+Latest Customer/);
    assert.match(result.stderr, /1 product key\(s\) have no activation/);
    assert.match(result.stderr, /pk-1: current customer unavailable:.*incomplete activation history/);
    assert.doesNotMatch(result.stdout, /Loading protection keys/);
    assert.doesNotMatch(result.stdout + result.stderr, /test # &\+%/);
    assert.equal(loginRequest.fields.get('username'), 'test-user');
    assert.equal(loginRequest.fields.get('password'), 'test # &+%');
    assert.equal(loginRequest.fields.get('user_type'), 'ISV');
    assert.ok(methods.some(([, url]) => url.includes('pageIndex=2')));
    assert.ok(methods.every(([method, url]) => method === 'GET' || method === 'POST' && url === '/ems/verifyLogin.html'));
    rejectLogin = true;
    await assert.rejects(run, (error) => {
      assert.match(error.stderr, /EMS did not confirm login \(HTTP 200\)/);
      assert.doesNotMatch(error.stdout + error.stderr, /test # &\+%/);
      return true;
    });
    rejectLogin = false;
    const source = fs.readFileSync(copy, 'utf8');
    assert.ok(source.includes('$showSpinner = -not [Console]::IsOutputRedirected'));
    fs.writeFileSync(copy, source.replace('$showSpinner = -not [Console]::IsOutputRedirected', '$showSpinner = $true'));
    slowLogin = true;
    const animated = await run();
    assert.match(animated.stdout, /Loading protection keys\.\.\. \|[\s\S]*Loading protection keys\.\.\. \//);
    assert.match(animated.stdout, /\r +\rSerial Number\s+Protection Key ID/);
    slowLogin = false;
    fs.writeFileSync(copy, source);
    noUpdates = true;
    const original = await run();
    assert.match(original.stdout, /06001\s+pk-2\s+Original Two/);
    noUpdates = false;
    escapedHistory = true;
    const wrapped = await run();
    assert.match(wrapped.stdout, /06001\s+pk-2\s+Latest Customer/);
    escapedHistory = false;
    missingCounter = true;
    const incomplete = await run();
    assert.match(incomplete.stdout, /06001\s+pk-2\s+Unavailable/);
    assert.match(incomplete.stderr, /pk-2: current customer unavailable: Activation counters/);
    missingCounter = false;
    largeSerials = true;
    const numeric = await run();
    assert.match(numeric.stdout, /100000\s+pk-1[\s\S]*99999\s+pk-2/);
    largeSerials = false;
    badSerial = true;
    await assert.rejects(run, (error) => {
      assert.match(error.stderr, /Serial Number memory is missing or invalid/);
      assert.doesNotMatch(error.stdout, /0600[12]/);
      return true;
    });
    badSerial = false;
    conflicting = true;
    await assert.rejects(run, (error) => {
      assert.match(error.stderr, /conflicting serial numbers/);
      assert.doesNotMatch(error.stdout, /0600[12]/);
      return true;
    });
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    fs.unlinkSync(copy);
    fs.rmdirSync(tempDir);
  }
});

test('PowerShell helper defaults to quiet insecure TLS and can enable verification', {
  skip: process.platform !== 'win32',
}, async () => {
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

  const server = https.createServer({ key: keys.privateKey, cert: forge.pki.certificateToPem(certificate) }, (req, res) => {
    if (req.url === '/ems/login.html') {
      res.end('login');
    } else {
      res.writeHead(401);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const helper = path.join(__dirname, '..', 'config-helper-scripts', 'get-protection-key-serials.ps1').replace(/'/g, "''");
    const url = `https://127.0.0.1:${server.address().port}`;
    const command = `function Get-Credential { param($Message) [PSCredential]::new('test-user', (ConvertTo-SecureString 'test-password' -AsPlainText -Force)) }; & '${helper}' -BaseUrl '${url}'`;
    const run = (suffix = '') => execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command + suffix], {
      timeout: 30000,
      env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    });
    await assert.rejects(run(' -Insecure:$false'), (error) => {
      assert.match(error.stderr, /Unable to list protection keys:.*certificate/i);
      assert.doesNotMatch(error.stdout + error.stderr, /test-password/);
      return true;
    });
    for (const suffix of ['', ' -Insecure']) await assert.rejects(run(suffix), (error) => {
      assert.match(error.stderr, /EMS did not confirm login \(HTTP 401\)/);
      assert.doesNotMatch(error.stdout + error.stderr, /NODE_TLS_REJECT_UNAUTHORIZED|TLS certificate verification is disabled/);
      assert.doesNotMatch(error.stdout + error.stderr, /test-password/);
      return true;
    });
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
