/**
 * Validate submitted SAOT values against the current EMS product metadata.
 * Every expected segment must occur once and contain exactly its configured
 * number of bytes; unsupported dynamic SAOT memory is rejected.
 */
function validateMemoryValues(productIds, productFiles, values) {
  const invalid = (message) => {
    const error = new Error(message);
    error.status = 400;
    throw error;
  };
  if (!Array.isArray(values)) invalid('Memory segment values must be a list.');

  const expected = new Map();
  for (const productId of productIds.map(String)) {
    for (const file of productFiles[productId]) {
      for (const segment of file.segments.filter((entry) => entry.saot)) {
        if (file.kind !== 'product') {
          invalid('SAOT dynamic memory is not supported when saving an entitlement. Use EMS to create this entitlement.');
        }
        if (!/^[1-9]\d*$/.test(String(segment.id)) || !/^[1-9]\d*$/.test(String(segment.size))) {
          invalid('EMS returned an SAOT segment without a valid ID or size.');
        }
        const key = `${productId}:${segment.id}`;
        if (expected.has(key)) invalid('EMS returned duplicate SAOT segment IDs.');
        expected.set(key, segment);
      }
    }
  }
  const result = [];
  const usedIds = new Set();
  for (const value of values) {
    if (!value || typeof value !== 'object') invalid('Invalid memory segment value.');
    const key = `${value.productId}:${value.segmentId}`;
    const segment = expected.get(key);
    if (!segment || usedIds.has(String(segment.id))) invalid('Unexpected or duplicate SAOT segment value.');
    if (typeof value.content !== 'string' || !/^[0-9a-fA-F]+$/.test(value.content) ||
        value.content.length !== Number(segment.size) * 2) {
      invalid(`SAOT memory segment ${segment.name || segment.id} requires exactly ${segment.size} bytes of hexadecimal data.`);
    }
    expected.delete(key);
    usedIds.add(String(segment.id));
    result.push({ id: String(segment.id), content: value.content.toUpperCase() });
  }
  if (expected.size) invalid('Enter a value for every SAOT memory segment.');
  return result;
}

module.exports = { validateMemoryValues };
