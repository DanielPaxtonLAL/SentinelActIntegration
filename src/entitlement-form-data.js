const fs = require('fs');

const isProductId = (value) => /^[1-9]\d*$/.test(String(value));
const TEST_PRODUCT_ID = 'test-ems-server-product-id';
const PRODUCTION_PRODUCT_ID = 'production-ems-server-product-id';
const TEST_SERIAL_CUSTOMER_ID = 'test-ems-server-next-serial-number-customer-id';
const PRODUCTION_SERIAL_CUSTOMER_ID = 'production-ems-server-next-serial-number-customer-id';

function productIdFor(option, name, isTestMode) {
  if (!option || typeof option !== 'object' || Array.isArray(option)) {
    throw new Error(`entitlement form data: "${name}" must contain test and production product IDs`);
  }
  const usesAddRemove = ['add-test', 'remove-test', 'add-production', 'remove-production']
    .some((key) => Object.hasOwn(option, key));
  const keys = usesAddRemove
    ? ['add-test', 'remove-test', 'add-production', 'remove-production']
    : [TEST_PRODUCT_ID, PRODUCTION_PRODUCT_ID];
  for (const key of keys) {
    if (typeof option[key] !== 'string' || (option[key].trim() !== '' && !isProductId(option[key].trim()))) {
      throw new Error(`entitlement form data: "${name}.${key}" must be an empty string or a positive product ID`);
    }
  }
  const selectedKey = usesAddRemove
    ? (isTestMode ? 'add-test' : 'add-production')
    : (isTestMode ? TEST_PRODUCT_ID : PRODUCTION_PRODUCT_ID);
  return option[selectedKey].trim();
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

  const serialCustomer = json['next-serial-number-customer-id'];
  if (!serialCustomer || typeof serialCustomer !== 'object' || Array.isArray(serialCustomer)) {
    throw new Error('entitlement form data: "next-serial-number-customer-id" must contain test and production customer IDs');
  }
  for (const key of [TEST_SERIAL_CUSTOMER_ID, PRODUCTION_SERIAL_CUSTOMER_ID]) {
    if (typeof serialCustomer[key] !== 'string' || !isProductId(serialCustomer[key].trim())) {
      throw new Error(`entitlement form data: "next-serial-number-customer-id.${key}" must be a positive number`);
    }
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
  const featureProductIds = Object.fromEntries([
    ['standalone', accessOptions, json['product-options']],
    ['link', accessOptions, json['product-options']],
    ['pivot', optionalOptions, json['optional-products']],
  ].map(([key, options, group]) => {
    const option = options.find((entry) => entry.key === key);
    return [key, option ? {
      add: option.id,
      remove: (group[key][isTestMode ? 'remove-test' : 'remove-production'] ?? '').trim(),
    } : null];
  }));

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
    nextProductKeySerialNumberCustomerId: serialCustomer[
      isTestMode ? TEST_SERIAL_CUSTOMER_ID : PRODUCTION_SERIAL_CUSTOMER_ID
    ].trim(),
    accessProducts,
    optionalProducts,
    versionProducts,
    defaultVersionLabel: defaults[0]?.label ?? '',
    lease,
    leaseExpiryRange: { minMonths: range['min-months'], maxMonths: range['max-months'] },
    productAliases,
    pivotProductIds: featureProductIds.pivot,
    featureProductIds,
  };
}

/** Validate both environments, then return the selected product IDs and labels. */
function parseFormData(json, isTestMode) {
  if (typeof isTestMode !== 'boolean') throw new Error('entitlement form data: test mode must be a boolean');
  const selected = parseFormDataForMode(json, isTestMode);
  parseFormDataForMode(json, !isTestMode);
  return selected;
}

/** Read and validate the JSON form configuration from disk. */
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
