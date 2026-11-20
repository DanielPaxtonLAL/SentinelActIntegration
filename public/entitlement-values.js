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

  return { encodeSerialNumber, encodeLeaseExpiryDate };
})();

if (typeof module !== 'undefined') module.exports = EntitlementValues;
