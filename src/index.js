// Usage:
//   node src/index.js <emsUrl> [apiPath]
//   EMS_USER / EMS_PASS env vars supply credentials.
//   EMS_INSECURE=1 to allow self-signed TLS certificates.
// Example:
//   $env:EMS_USER="admin"; $env:EMS_PASS="secret"
//   node src/index.js https://ems.example.com /customers

const fs = require('fs');
const path = require('path');
const { EmsClient } = require('./ems-client');
const { getEmsConfig, getEmsConfigForUrl } = require('./ems-config');
const { loadEnvironmentFile } = require('./environment');

const envFile = path.join(__dirname, '..', '.env');
loadEnvironmentFile(envFile, process.env, fs);

async function main() {
  const args = process.argv.slice(2);
  const argUrl = /^https?:\/\//i.test(args[0] || '') ? args.shift() : '';
  const [apiPath, apiArg] = args;
  const { EMS_USER, EMS_PASS, EMS_INSECURE } = process.env;
  const configured = argUrl ? getEmsConfigForUrl(process.env, argUrl) : getEmsConfig(process.env);
  const url = argUrl || configured.baseUrl;
  if (!url || !EMS_USER || !EMS_PASS) {
    console.error('Usage: node src/index.js <emsUrl> [apiPath]  (set EMS_USER and EMS_PASS)');
    process.exit(1);
  }

  const ems = new EmsClient({
    baseUrl: url,
    username: EMS_USER,
    password: EMS_PASS,
    insecure: configured ? configured.insecure : EMS_INSECURE === '1',
    apiVersion: configured ? configured.apiVersion : process.env.EMS_API_VERSION || 'v90',
    userType: configured ? configured.userType : process.env.EMS_USER_TYPE || 'ISV',
  });

  console.log('Authenticating with', url);
  console.log('Session:', await ems.authenticate());

  const show = (d) => console.log(typeof d === 'string' ? d : JSON.stringify(d, null, 2));
  if (apiPath === 'entitlements') show(await ems.listEntitlements());
  else if (apiPath === 'entitlement') show(await ems.getEntitlement(apiArg));
  else if (apiPath) show(await ems.call(apiPath));
}

main().catch((e) => {
  console.error(e.message);
  if (e.body) console.error(typeof e.body === 'string' ? e.body : JSON.stringify(e.body));
  process.exit(1);
});
