/** Decode stored ASCII-hex serials, including older raw hexadecimal values. */
function decodeProductKeySerial(text) {
  const value = String(text ?? '').trim();
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) return null;
  const decoded = Buffer.from(value, 'hex').toString('latin1');
  const serial = /^[0-9a-f]+$/i.test(decoded)
    ? BigInt(`0x${decoded}`)
    : BigInt(`0x${value}`);
  return serial <= 65535n ? Number(serial) : null;
}

function duplicateProductKeySerialError(serialNumber) {
  const error = new Error(`Serial number ${String(serialNumber).padStart(5, '0')} is already claimed by another entitlement.`);
  error.status = 409;
  return error;
}

/** Create a process-local FIFO lock that releases even when an operation fails. */
function createLock() {
  let queue = Promise.resolve();
  return async (operation) => {
    const previous = queue;
    let release;
    queue = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

/**
 * Coordinate serial checks, draft saves and counter updates within one app process.
 * The save and counter locks are separate: a saved draft remains saved even if
 * the subsequent counter update fails.
 * @param {{baseProductId: string, withSession: Function}} options Selected base product and session guard.
 */
function createProductKeySerials({ baseProductId, withSession }) {
  const withProductKeySerialLock = createLock();
  const withCounterLock = createLock();

  /** Increment the shared EMS customer counter, serialized with other increments. */
  async function incrementProductKeySerial(ems) {
    return withCounterLock(async () => {
      const largest = await withSession(ems, () => ems.getLargestProductKeySerial());
      if (!Number.isInteger(largest) || largest < 0 || largest >= 65535) {
        throw new Error('The serial number customer must contain a whole number below 65,535 before it can be incremented.');
      }
      const next = largest + 1;
      await withSession(ems, () => ems.setLargestProductKeySerial(next));
      return next;
    });
  }

  /** Scan base-product memory, optionally excluding the draft currently being edited. */
  async function getUsedProductKeySerialNumbers(ems, excludedEntitlementId) {
    const entitlements = await withSession(ems, () => ems.listEntitlements());
    const entitlementIds = entitlements.map((entitlement) =>
      String(entitlement.id ?? entitlement.entitlementId ?? '')
    );
    if (entitlementIds.some((id) => !/^[1-9]\d*$/.test(id))) {
      throw new Error('EMS returned an entitlement without a valid ID.');
    }

    const serialNumbers = new Set();
    const idsToCheck = excludedEntitlementId === undefined
      ? entitlementIds
      : entitlementIds.filter((id) => id !== String(excludedEntitlementId));
    for (let index = 0; index < idsToCheck.length; index += 10) {
      const batch = await Promise.all(idsToCheck.slice(index, index + 10).map((id) =>
        withSession(ems, () => ems.getEntitlementDetails(id, { includeCustomer: false }))
      ));
      for (const details of batch) {
        for (const product of details.products || []) {
          if (String(product.productId) !== String(baseProductId)) continue;
          for (const segment of product.memorySegments || []) {
            if (!segment.saot || typeof segment.name !== 'string' ||
                segment.name.trim().toLowerCase() !== 'serial number') continue;
            const text = String(segment.text ?? '').trim();
            if (!text) continue;
            if (!/^(?:[0-9a-f]{2})+$/i.test(text)) {
              throw new Error(`EMS returned an invalid Serial Number value in entitlement ${details.id}.`);
            }
            const serialValue = decodeProductKeySerial(text);
            if (serialValue !== null) serialNumbers.add(serialValue);
          }
        }
      }
    }
    return serialNumbers;
  }

  return { withProductKeySerialLock, incrementProductKeySerial, getUsedProductKeySerialNumbers };
}

module.exports = { createProductKeySerials, decodeProductKeySerial, duplicateProductKeySerialError };
