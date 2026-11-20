function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build the XML payload for a new EMS entitlement.
 * The line-item type also determines the key and activation counts.
 */
function buildEntitlementXml(entitlement) {
  const lineItemType = entitlement.lineItemType;
  if (!['Hardware_Key', 'Product_Key', 'ProtectionKey_Update'].includes(lineItemType)) {
    throw new Error('Unsupported entitlement line item type.');
  }

  const productKeyCount = lineItemType === 'Product_Key' ? entitlement.numberOfKeys : 1;
  const activationCount = lineItemType === 'ProtectionKey_Update'
    ? entitlement.numberOfUpdates
    : entitlement.activationsPerKey;

  if (!Array.isArray(entitlement.productIds) ||
      entitlement.productIds.length === 0 ||
      new Set(entitlement.productIds.map(String)).size !== entitlement.productIds.length) {
    throw new Error('At least one unique product is required.');
  }

  const item = (name, value) => `<${name}>${escapeXml(value)}</${name}>`;
  const entitlementXml =
    '<entitlement>' +
    (entitlement.eid ? item('eid', entitlement.eid) : '') +
    '<enabled>true</enabled><action>Save</action><isTest>false</isTest>' +
    item('customerId', entitlement.customerId) +
    '<customerEmail></customerEmail><partnerId></partnerId><partnerEmail></partnerEmail>' +
    item('refId1', entitlement.refId1) +
    item('refId2', entitlement.refId2) +
    item('description', entitlement.description) +
    '<proContId></proContId>' +
    (entitlement.createDate ? item('createDate', entitlement.createDate) : '') +
    item('startDate', entitlement.startDate) +
    item('endDate', entitlement.endDate) +
    '<identity></identity><policy><revocationAllowed>true</revocationAllowed></policy>' +
    '<entitlementItem>' +
    '<priority>D</priority><type>CLOUD_KEY</type><deploymentType></deploymentType>' +
    '<featureCachingMode></featureCachingMode><containerType>0</containerType>' +
    item('startDate', entitlement.startDate) +
    item('endDate', entitlement.endDate) +
    '<itemLicenseType>0</itemLicenseType>' +
    item('lineItemType', lineItemType) +
    item('numActivationPerProductKey', activationCount) +
    item('numProductKeys', productKeyCount) +
    (lineItemType === 'ProtectionKey_Update'
      ? (entitlement.haspIds || []).map((id) => item('haspId', id)).join('')
      : '') +
    item('vendorId', entitlement.vendorId) +
    item('enforcementId', entitlement.enforcementId) +
    entitlement.productIds.map((productId) =>
      '<itemProduct><isRevoked>false</isRevoked>' +
      item('productId', productId) +
      '</itemProduct>'
    ).join('') +
    (entitlement.memorySegments?.length
      ? '<memorySegments>' + entitlement.memorySegments.map((segment) =>
        '<segment><lineItemMemorySegmentID></lineItemMemorySegmentID>' +
        item('prdMemorySegmentId', segment.id) +
        '<prdSuiteLineItemId></prdSuiteLineItemId>' +
        item('data', segment.content) + '</segment>'
      ).join('') + '</memorySegments>'
      : '') +
    '</entitlementItem>' +
    '</entitlement>';
  return { entitlementXml, lineItemType };
}

module.exports = { buildEntitlementXml };
