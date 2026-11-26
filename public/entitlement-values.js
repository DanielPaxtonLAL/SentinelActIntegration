var EntitlementValues = (() => {
  /** Encode a decimal serial as ASCII hexadecimal digits stored in hexadecimal. */
  function encodeSerialNumber(value, size) {
    const digitCount = Number(size);
    if (!/^\d+$/.test(value) || !Number.isInteger(digitCount) || digitCount < 1) {
      throw new Error('Enter the serial number as a decimal number.');
    }
    const hex = BigInt(value).toString(16).toUpperCase();
    if (hex.length > digitCount) {
      throw new Error(`Serial number must be ${(16n ** BigInt(digitCount) - 1n).toLocaleString('en-NZ')} or less.`);
    }
    return Array.from(hex.padStart(digitCount, '0'), (digit) => digit.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('');
  }

  /** Encode a calendar date as the four ASCII hex digits expected by EMS memory. */
  function encodeLeaseExpiryDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) throw new Error('Select a valid lease expiry date between 1980 and 2107.');
    const [, yearText, monthText, dayText] = match;
    const year = Number(yearText), month = Number(monthText), day = Number(dayText);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (year < 1980 || year > 2107 || date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      throw new Error('Select a valid lease expiry date between 1980 and 2107.');
    }
    const digits = ((year - 1980) * 512 + month * 32 + day).toString(16).toUpperCase().padStart(4, '0');
    return Array.from(digits, (digit) => digit.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('');
  }

  function asciiHex(text) {
    const value = String(text ?? '').trim();
    if (!/^(?:[0-9a-f]{2})+$/i.test(value)) return '';
    return value.match(/../g).map((pair) => String.fromCharCode(parseInt(pair, 16))).join('');
  }

  function decodeSerialNumber(segments) {
    const matches = segments.filter((segment) => segment.saot && typeof segment.name === 'string' &&
      segment.name.trim().toLowerCase() === 'serial number');
    if (matches.length !== 1) return 'Unavailable';
    const digits = asciiHex(matches[0].text);
    if (!/^[0-9a-f]+$/i.test(digits)) return 'Unavailable';
    return BigInt(`0x${digits}`).toString().padStart(5, '0');
  }

  function decodeExpiryDate(segments, allowZero = false) {
    const matches = segments.filter((segment) => typeof segment.name === 'string' &&
      segment.name.trim().toLowerCase() === 'expiry date');
    if (matches.length !== 1) return 'Unavailable';
    const text = String(matches[0].text ?? '').trim();
    if (!/^(?:[0-9a-f]{2})+$/i.test(text)) return 'Unavailable';
    const candidates = [];
    const decoded = asciiHex(text);
    if (/^[0-9a-f]{4}$/i.test(decoded)) candidates.push(parseInt(decoded, 16));
    const raw = parseInt(text, 16);
    if (text.length <= 8 && raw <= 0xFFFF) candidates.push(raw);
    for (const value of candidates) {
      if (value === 0 && allowZero) return '0000';
      const year = (value >> 9) + 1980;
      const month = (value >> 5) & 0xF;
      const day = value & 0x1F;
      const date = new Date(Date.UTC(year, month - 1, day));
      if (value && month >= 1 && month <= 12 && day >= 1 &&
          date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
        return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }
    return 'Unavailable';
  }

  function decodeVersion(segments, versionMemory = null) {
    const matches = segments.filter((segment) => typeof segment.name === 'string' &&
      segment.name.trim().toLowerCase() === 'version');
    if (!matches.length) return 'Unavailable';
    if (matches.length !== 1) return 'Invalid version data';
    const text = String((versionMemory ? versionMemory.content : matches[0].text) ?? '').trim();
    if (!/^[0-9a-f]{8}$/i.test(text)) return 'Invalid version data';
    const versionHex = asciiHex(text);
    if (!/^[0-9a-f]{4}$/i.test(versionHex)) return 'Invalid version data';
    return 'v' + ((parseInt(versionHex, 16) ^ 0xBEAD) / 1000);
  }

  function memoryOffset(value) {
    const text = String(value ?? '').trim();
    return /^(?:0x[0-9a-f]+|\d+)$/i.test(text) ? Number(text) : NaN;
  }

  function versionSegmentRange(segments) {
    const versions = segments.filter((segment) => typeof segment.name === 'string' && segment.name.trim().toLowerCase() === 'version');
    if (versions.length !== 1) throw new Error('the base Version segment is missing or ambiguous');
    const baseOffset = memoryOffset(versions[0].offset);
    const baseSize = Number(versions[0].size);
    if (!Number.isSafeInteger(baseOffset) || !Number.isSafeInteger(baseSize) || baseSize !== 4) {
      throw new Error('the base Version segment has invalid memory metadata');
    }
    return { baseOffset, baseSize };
  }

  function versionWrite(segments, files) {
    const { baseOffset, baseSize } = versionSegmentRange(segments);
    if (!Array.isArray(files)) throw new Error('invalid version product memory');
    const writes = files.filter((file) => file.kind === 'product').flatMap((file) => {
      if (!Array.isArray(file.segments)) throw new Error('invalid version product memory segments');
      return file.segments;
    });
    const overlaps = writes.filter((segment) => {
      const start = memoryOffset(segment.offset);
      const size = Number(segment.size);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || size <= 0) {
        throw new Error('invalid version product memory metadata');
      }
      return start < baseOffset + baseSize && baseOffset < start + size;
    });
    if (overlaps.length !== 1 || memoryOffset(overlaps[0].offset) !== baseOffset ||
        Number(overlaps[0].size) !== baseSize || overlaps[0].saot !== false) {
      throw new Error('the version product does not contain one complete fixed Version write');
    }
    return overlaps[0];
  }

  return { encodeSerialNumber, encodeLeaseExpiryDate, decodeSerialNumber, decodeExpiryDate, decodeVersion, versionSegmentRange, versionWrite };
})();

if (typeof module !== 'undefined') module.exports = EntitlementValues;
