function getEmsConfig(env, args = []) {
  if (args.length > 1 || (args.length === 1 && !['--test', '--production'].includes(args[0]))) {
    throw new Error('Use --test or --production to select the EMS environment.');
  }
  const mode = args.length ? (args[0] === '--test' ? 'true' : 'false') : env.IS_TEST_MODE;
  if (mode !== 'true' && mode !== 'false') {
    throw new Error('Set IS_TEST_MODE to true or false in .env.');
  }
  const isTestMode = mode === 'true';
  const prefix = isTestMode ? 'TEST' : 'PRODUCTION';
  const baseUrl = env[`${prefix}_EMS_URL`];
  if (!baseUrl) throw new Error(`Set ${prefix}_EMS_URL in .env.`);
  const insecure = env[`${prefix}_EMS_INSECURE`] || '0';
  if (insecure !== '0' && insecure !== '1') {
    throw new Error(`Set ${prefix}_EMS_INSECURE to 0 or 1 in .env.`);
  }
  return {
    isTestMode,
    baseUrl,
    insecure: insecure === '1',
    apiVersion: env[`${prefix}_EMS_API_VERSION`] || 'v90',
    userType: env[`${prefix}_EMS_USER_TYPE`] || 'ISV',
  };
}

function getEmsConfigForUrl(env, url) {
  const target = new URL(url).href.replace(/\/+$/, '');
  const matches = ['PRODUCTION', 'TEST'].filter((prefix) => {
    const configured = env[`${prefix}_EMS_URL`];
    return configured && new URL(configured).href.replace(/\/+$/, '') === target;
  });
  if (matches.length > 1) throw new Error('Test and production EMS URLs must be different to select connection settings.');
  if (!matches.length) return null;
  return getEmsConfig({ ...env, IS_TEST_MODE: matches[0] === 'TEST' ? 'true' : 'false' });
}

module.exports = { getEmsConfig, getEmsConfigForUrl };
