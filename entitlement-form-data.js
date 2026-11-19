const fs = require('fs');

const isProductId = (value) => /^[1-9]\d*$/.test(String(value));
const TEST_PRODUCT_ID = 'test-ems-server-product-id';
const PRODUCTION_PRODUCT_ID = 'production-ems-server-product-id';

function productIdFor(option, name, isTestMode) {
  if (!option || typeof option !== 'object' || Array.isArray(option)) {
    throw new Error(`entitlement form data: "${name}" must contain test and production product IDs`);
  }
  for (const key of [TEST_PRODUCT_ID, PRODUCTION_PRODUCT_ID]) {
    if (typeof option[key] !== 'string' || (option[key].trim() !== '' && !isProductId(option[key].trim()))) {
      throw new Error(`entitlement form data: "${name}.${key}" must be an empty string or a positive product ID`);
    }
  }
  return option[isTestMode ? TEST_PRODUCT_ID : PRODUCTION_PRODUCT_ID].trim();
}

// Keys starting with "_" are comments. Everything else in a group is an option.
function optionsOf(group, name, isTestMode) {
  if (!group || typeof group !== 'object' || Array.isArray(group)) {
    throw new Error(`entitlement form data: "${name}" must be an object`);
  }
  return Object.entries(group)
    .filter(([key]) => !key.startsWith('_'))
    .map(([key, option]) => {
      if (!option || typeof option !== 'object' || typeof option.label !== 'string' || !option.label.trim()) {
        throw new Error(`entitlement form data: "${name}.${key}" needs a label`);
      }
      const id = productIdFor(option, `${name}.${key}`, isTestMode);
      return { key, label: option.label.trim(), id };
    });
}

function parseFormDataForMode(json, isTestMode) {
  const base = productIdFor(json['base-product-id'], 'base-product-id', isTestMode);
  if (!isProductId(base)) throw new Error('entitlement form data: "base-product-id" must be a positive number');

  const serialCustomerId = json['highest-product-key-serial-number-customer-id'];
  if (serialCustomerId !== undefined && (typeof serialCustomerId !== 'string' || !isProductId(serialCustomerId))) {
    throw new Error('entitlement form data: "highest-product-key-serial-number-customer-id" must be a positive number');
  }
  const range = json['lease-expiry-range'];
  if (!range || !Number.isSafeInteger(range['min-months']) || !Number.isSafeInteger(range['max-months']) ||
      range['min-months'] < 0 || range['max-months'] < range['min-months'] || range['max-months'] > 1200) {
    throw new Error('entitlement form data: "lease-expiry-range" needs valid min-months and max-months');
  }
  const requireIds = (options, name) => {
    const missing = options.find((option) => !option.id);
    if (missing) throw new Error(`entitlement form data: "${name}.${missing.key}" needs a product-id`);
    return options.map(({ id, label }) => ({ id, label }));
  };

  const accessOptions = optionsOf(json['product-options'], 'product-options', isTestMode);
  const accessProducts = requireIds(accessOptions, 'product-options');
  if (!accessProducts.length) throw new Error('entitlement form data: "product-options" needs at least one option');
  const optionalOptions = optionsOf(json['optional-products'], 'optional-products', isTestMode);
  const optionalProducts = requireIds(optionalOptions, 'optional-products');

  const versionOptions = optionsOf(json.version, 'version', isTestMode);
  const defaults = versionOptions.filter((option) => !option.id);
  if (defaults.length > 1) throw new Error('entitlement form data: "version" can have only one option without a product-id (the default)');
  const versionProducts = versionOptions.filter((option) => option.id).map(({ id, label }) => ({ id, label }));

  const leaseOptions = optionsOf(json.lease, 'lease', isTestMode);
  if (leaseOptions.length !== 1 || !leaseOptions[0].id) {
    throw new Error('entitlement form data: "lease" needs exactly one option with a product-id');
  }
  const lease = { id: leaseOptions[0].id, label: leaseOptions[0].label };
  const productAliases = [
    ...accessOptions.map(({ key: alias, id }) => ({ alias, id, group: 'product' })),
    ...optionalOptions.map(({ key: alias, id }) => ({ alias, id, group: 'optional' })),
    ...versionOptions.map(({ key: alias, id }) => ({ alias, id, group: 'version' })),
    ...leaseOptions.map(({ key: alias, id }) => ({ alias, id, group: 'lease' })),
  ];

  const all = [base, ...accessProducts, ...optionalProducts, ...versionProducts, lease].map((item) => item.id ?? item);
  const duplicate = all.find((id, index) => all.indexOf(id) !== index);
  if (duplicate) throw new Error(`entitlement form data: product-id ${duplicate} is used more than once`);

  return {
    baseProductId: base,
    highestProductKeySerialNumberCustomerId: serialCustomerId,
    accessProducts,
    optionalProducts,
    versionProducts,
    defaultVersionLabel: defaults[0]?.label ?? '',
    lease,
    leaseExpiryRange: { minMonths: range['min-months'], maxMonths: range['max-months'] },
    productAliases,
  };
}

function parseFormData(json, isTestMode) {
  if (typeof isTestMode !== 'boolean') throw new Error('entitlement form data: test mode must be a boolean');
  const selected = parseFormDataForMode(json, isTestMode);
  parseFormDataForMode(json, !isTestMode);
  return selected;
}

function loadFormData(file, isTestMode) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read entitlement form data ${file}: ${err.message}`);
  }
  return parseFormData(json, isTestMode);
}

module.exports = { loadFormData, parseFormData };
