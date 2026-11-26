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

  /** Seed the persistent counter from the highest serial currently in EMS. */
  async function initializeNextProductKeySerial(ems) {
    return withCounterLock(async () => {
      const serialNumbers = await getUsedProductKeySerialNumbers(ems);
      let largest = 6000;
      for (const serialNumber of serialNumbers) {
        largest = Math.max(largest, serialNumber);
      }
      const next = largest + 1;
      if (next > 65536) throw new Error('No serial numbers remain above 06000.');
      await withSession(ems, () => ems.setNextProductKeySerial(next));
      return next;
    });
  }

  /** Advance the shared counter after creating the entitlement assigned that serial. */
  async function advanceProductKeySerial(ems, serialNumber) {
    return withCounterLock(async () => {
      const next = await withSession(ems, () => ems.getNextProductKeySerial());
      if (next !== serialNumber) {
        const error = new Error(`The next serial number changed to ${String(next).padStart(5, '0')}. Reload the form and try again.`);
        error.status = 409;
        throw error;
      }
      await withSession(ems, () => ems.setNextProductKeySerial(next + 1));
      return next + 1;
    });
  }

  /** Scan base-product memory, optionally excluding the draft currently being edited. */
  async function getUsedProductKeySerialNumbers(ems, excludedEntitlementId) {
    const entitlements = await withSession(ems, () => ems.listEntitlementsForActivations());
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
        if (!Array.isArray(details.products)) {
          throw new Error(`EMS returned an invalid product list in entitlement ${details.id}.`);
        }
        for (const product of details.products) {
          if (String(product.productId) !== String(baseProductId)) continue;
          if (!Array.isArray(product.memorySegments)) {
            throw new Error(`EMS returned invalid base product memory in entitlement ${details.id}.`);
          }
          const segments = product.memorySegments.filter((segment) => segment.saot &&
            typeof segment.name === 'string' && segment.name.trim().toLowerCase() === 'serial number');
          if (segments.length !== 1) {
            throw new Error(`EMS did not return one Serial Number segment in entitlement ${details.id}.`);
          }
          for (const segment of segments) {
            const text = String(segment.text ?? '').trim();
            if (!text) continue;
            if (!/^(?:[0-9a-f]{2})+$/i.test(text)) {
              throw new Error(`EMS returned an invalid Serial Number value in entitlement ${details.id}.`);
            }
            const serialValue = decodeProductKeySerial(text);
            if (serialValue === null) {
              continue;
            }
            serialNumbers.add(serialValue);
          }
        }
      }
    }
    return serialNumbers;
  }

  return {
    withProductKeySerialLock,
    initializeNextProductKeySerial,
    advanceProductKeySerial,
    getUsedProductKeySerialNumbers,
  };
}

module.exports = { createProductKeySerials, decodeProductKeySerial, duplicateProductKeySerialError };
