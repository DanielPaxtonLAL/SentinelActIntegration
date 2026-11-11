var LeaseDates = (() => {
  function parseDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) throw new Error('Expected a date in YYYY-MM-DD format.');
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      throw new Error('Invalid calendar date.');
    }
    return { year, month, day };
  }

  function addMonths(value, months) {
    const { year, month, day } = parseDate(value);
    const first = new Date(Date.UTC(year, month - 1 + months, 1));
    const targetYear = first.getUTCFullYear(), targetMonth = first.getUTCMonth();
    const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    return `${String(targetYear).padStart(4, '0')}-${String(targetMonth + 1).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
  }

  function bounds(start, today, range) {
    parseDate(today);
    const earliest = addMonths(start, range.minMonths);
    return {
      min: [earliest, today, '1980-01-01'].sort().at(-1),
      max: [addMonths(start, range.maxMonths), '2107-12-31'].sort()[0],
    };
  }

  function decode(content) {
    if (typeof content !== 'string' || !/^(?:[0-9a-f]{2}){4}$/i.test(content)) {
      throw new Error('Invalid lease expiry date memory.');
    }
    const digits = content.match(/../g).map((pair) => String.fromCharCode(parseInt(pair, 16))).join('');
    if (!/^[0-9a-f]{4}$/i.test(digits)) throw new Error('Invalid lease expiry date memory.');
    const value = parseInt(digits, 16);
    const date = `${String((value >> 9) + 1980).padStart(4, '0')}-${String((value >> 5) & 15).padStart(2, '0')}-${String(value & 31).padStart(2, '0')}`;
    parseDate(date);
    return date;
  }

  function validate(value, start, today, range) {
    parseDate(value);
    const { min, max } = bounds(start, today, range);
    if (value < min || value > max) {
      throw new Error(`Lease expiry date must be between ${min} and ${max} and not in the past.`);
    }
  }

  return { addMonths, bounds, decode, validate };
})();

if (typeof module !== 'undefined') module.exports = LeaseDates;
