const fs = require('fs');

const isProductId = (value) => /^[1-9]\d*$/.test(String(value));

// Keys starting with "_" are comments. Everything else in a group is an option.
function optionsOf(group, name) {
  if (!group || typeof group !== 'object' || Array.isArray(group)) {
    throw new Error(`entitlement form data: "${name}" must be an object`);
  }
  return Object.entries(group)
    .filter(([key]) => !key.startsWith('_'))
    .map(([key, option]) => {
      if (!option || typeof option !== 'object' || typeof option.label !== 'string' || !option.label.trim()) {
        throw new Error(`entitlement form data: "${name}.${key}" needs a label`);
      }
      const id = option['product-id'] === undefined || option['product-id'] === null ? '' : String(option['product-id']).trim();
      if (id !== '' && !isProductId(id)) {
        throw new Error(`entitlement form data: "${name}.${key}" has an invalid product-id "${id}"`);
      }
      return { key, label: option.label.trim(), id };
    });
}

function parseFormData(json) {
  const base = String(json['base-product-id'] ?? '').trim();
  if (!isProductId(base)) throw new Error('entitlement form data: "base-product-id" must be a positive number');

  const requireIds = (options, name) => {
    const missing = options.find((option) => !option.id);
    if (missing) throw new Error(`entitlement form data: "${name}.${missing.key}" needs a product-id`);
    return options.map(({ id, label }) => ({ id, label }));
  };

  const accessOptions = optionsOf(json['product-options'], 'product-options');
  const accessProducts = requireIds(accessOptions, 'product-options');
  if (!accessProducts.length) throw new Error('entitlement form data: "product-options" needs at least one option');
  const optionalOptions = optionsOf(json['optional-products'], 'optional-products');
  const optionalProducts = requireIds(optionalOptions, 'optional-products');

  const versionOptions = optionsOf(json.version, 'version');
  const defaults = versionOptions.filter((option) => !option.id);
  if (defaults.length > 1) throw new Error('entitlement form data: "version" can have only one option without a product-id (the default)');
  const versionProducts = versionOptions.filter((option) => option.id).map(({ id, label }) => ({ id, label }));

  const leaseOptions = optionsOf(json.lease, 'lease');
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
    accessProducts,
    optionalProducts,
    versionProducts,
    defaultVersionLabel: defaults[0]?.label ?? '',
    lease,
    productAliases,
  };
}

function loadFormData(file) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read entitlement form data ${file}: ${err.message}`);
  }
  return parseFormData(json);
}

module.exports = { loadFormData, parseFormData };
