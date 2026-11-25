const AdmZip = require('adm-zip');
const { XMLParser, XMLBuilder, XMLValidator } = require('fast-xml-parser');

function buildHistoryV2cp(protectionKeyId, history) {
  if (history.warnings.length) {
    throw new Error(`Cannot build V2CP: activation history has warnings: ${history.warnings.join(' ')}`);
  }
  const entries = new Map();
  for (const activation of history.activations) {
    if (!activation.aid || activation.protectionKeyId !== protectionKeyId ||
        activation.counterError || !/^\d+$/.test(activation.updateCounter ?? '') ||
        typeof activation.activationString !== 'string') {
      throw new Error('Cannot build V2CP: an activation is missing its key, counter, or V2C.');
    }
    const previous = entries.get(activation.aid);
    if (previous && (previous.updateCounter !== activation.updateCounter ||
        previous.activationString !== activation.activationString)) {
      throw new Error('Cannot build V2CP: conflicting records for an activation.');
    }
    entries.set(activation.aid, activation);
  }
  const ordered = [...entries.values()].sort((a, b) => {
    const left = BigInt(a.updateCounter);
    const right = BigInt(b.updateCounter);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  if (!ordered.length || ordered.some((entry, index) => BigInt(entry.updateCounter) !== BigInt(index))) {
    throw new Error('Cannot build V2CP: update counters must form a complete sequence starting at 0.');
  }

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false });
  const zip = new AdmZip();
  let scope;
  for (const [index, entry] of ordered.entries()) {
    if (XMLValidator.validate(entry.activationString) !== true) {
      throw new Error('Cannot build V2CP: EMS returned invalid V2C XML.');
    }
    const info = parser.parse(entry.activationString)?.hasp_info;
    const vendor = info?.haspscope?.vendor;
    const hasp = vendor?.hasp;
    if (!vendor || Array.isArray(vendor) || !hasp || Array.isArray(hasp) ||
        typeof vendor['@_id'] !== 'string' || !vendor['@_id'].trim() ||
        hasp['@_id'] !== protectionKeyId || typeof info.v2c !== 'string' || !info.v2c.trim()) {
      throw new Error('Cannot build V2CP: a V2C has an invalid or unexpected protection key scope.');
    }
    if (scope && JSON.stringify(scope) !== JSON.stringify(info.haspscope)) {
      throw new Error('Cannot build V2CP: V2Cs have different protection key scopes.');
    }
    scope = info.haspscope;
    zip.addFile(`${index + 1}.v2c`, Buffer.from(entry.activationString, 'utf8'));
  }
  const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', suppressEmptyNode: true });
  return '<?xml version="1.0" encoding="utf-8"?>' +
    builder.build({ hasp_info: { haspscope: scope, v2cp: zip.toBuffer().toString('base64') } });
}

module.exports = { buildHistoryV2cp };
