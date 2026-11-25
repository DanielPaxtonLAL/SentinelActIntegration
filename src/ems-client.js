const { XMLParser, XMLBuilder, XMLValidator } = require('fast-xml-parser');
const { buildEntitlementXml } = require('./entitlement-xml');

/** Collect activation IDs from EMS responses whose nesting varies by endpoint. */
function findActivationIds(value, ids = new Set()) {
  if (!value || typeof value !== 'object') return [...ids];
  for (const [name, child] of Object.entries(value)) {
    if (['aid', 'activationid'].includes(name.toLowerCase().replace(/[^a-z]/g, ''))) {
      for (const candidate of Array.isArray(child) ? child : [child]) {
        const id = typeof candidate === 'string' ? candidate : candidate?.['#text'];
        if (typeof id === 'string' && id.trim()) ids.add(id.trim());
      }
    } else {
      findActivationIds(child, ids);
    }
  }
  return [...ids];
}

/** Preserve the protection-key attribute attached to each activation ID. */
function findActivationReferences(value, references = []) {
  if (!value || typeof value !== 'object') return references;
  for (const [name, child] of Object.entries(value)) {
    if (['aid', 'activationid'].includes(name.toLowerCase().replace(/[^a-z]/g, ''))) {
      for (const candidate of Array.isArray(child) ? child : [child]) {
        const id = typeof candidate === 'string' ? candidate : candidate?.['#text'];
        const protectionKeyId = typeof candidate?.['@_protectionKeyId'] === 'string'
          ? candidate['@_protectionKeyId'].trim() : '';
        if (typeof id === 'string' && id.trim()) {
          references.push({ aid: id.trim(), protectionKeyId: protectionKeyId || null });
        }
      }
    } else {
      findActivationReferences(child, references);
    }
  }
  return references;
}

/** Extract readable diagnostics without including credentials, keys or C2V data. */
function activationErrorDetail(text, c2v, secrets) {
  const trimmed = text.trim();
  if (!trimmed) return '';
  let values = [];
  const fields = new Set(['error', 'errors', 'errorresponse', 'exception', 'fault',
    'code', 'errorcode', 'message', 'errormessage', 'description', 'errordescription', 'detail', 'faultstring']);
  const collect = (value, depth = 0) => {
    if (depth > 5 || values.length >= 5 || !value || typeof value !== 'object') return;
    for (const [name, child] of Object.entries(value)) {
      if (!fields.has(name.toLowerCase().replace(/[^a-z]/g, ''))) continue;
      if (typeof child === 'string' || typeof child === 'number') values.push(String(child));
      else if (Array.isArray(child)) child.slice(0, 5).forEach((item) => collect(item, depth + 1));
      else collect(child, depth + 1);
    }
  };
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { collect(JSON.parse(trimmed)); } catch { return ''; }
  } else if (trimmed.startsWith('<')) {
    if (XMLValidator.validate(trimmed) !== true) return '';
    collect(new XMLParser({ parseTagValue: false }).parse(trimmed));
  } else {
    values = [trimmed];
  }
  const sensitive = [...secrets, c2v, ...(c2v.match(/[A-Za-z0-9+/=_-]{12,}/g) || [])]
    .filter((value) => typeof value === 'string' && value);
  return values.map((value) => {
    if (/[<>]/.test(value) || /&(?:lt|gt|#0*60|#x0*3c);/i.test(value)) return '';
    for (const secret of sensitive) value = value.split(secret).join('[redacted]');
    return value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 500);
  }).filter(Boolean).join(' - ');
}

/**
 * Sentinel EMS web-session client. Cookies are kept per instance. Callers are
 * responsible for clearing credentials after authentication.
 */
class EmsClient {
  /**
   * @param {object} options EMS connection and authentication settings.
   * @param {string} options.baseUrl EMS server origin, without /ems.
   * @param {string} [options.username] EMS username, required for authentication.
   * @param {string} [options.password] EMS password, required for authentication.
   * @param {string} [options.apiVersion='v90'] EMS web-service version.
   * @param {string} [options.userType='ISV'] EMS login user type.
   * @param {boolean} [options.insecure=false] Disable TLS verification process-wide.
   * @param {string} [options.nextSerialNumberCustomerId] Customer whose Ref ID stores the next serial number.
   */
  constructor({ baseUrl, username, password, apiVersion = 'v90', userType = 'ISV', insecure = false, nextSerialNumberCustomerId }) {
    if (!baseUrl) throw new Error('baseUrl is required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiVersion = apiVersion;
    this.apiRoot = `${this.baseUrl}/ems/${apiVersion}/ws`;
    this.username = username;
    this.password = password;
    this.userType = userType; // 'ISV' for the vendor login, 'CUSTOMER' for the customer portal
    this.nextSerialNumberCustomerId = nextSerialNumberCustomerId;
    this.cookies = new Map();
    this.authenticated = false;
    if (insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed certs
  }

  _cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  _storeCookies(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async _fetch(url, opts = {}) {
    const res = await fetch(url, {
      redirect: 'manual',
      ...opts,
      headers: {
        ...(this.cookies.size ? { Cookie: this._cookieHeader() } : {}),
        ...opts.headers,
      },
    });
    this._storeCookies(res);
    return res;
  }

  /** Log in through the EMS web form and retain its JSESSIONID cookie. */
  async authenticate() {
    await this._fetch(`${this.baseUrl}/ems/login.html`);

    const res = await this._fetch(`${this.baseUrl}/ems/verifyLogin.html`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        username: this.username,
        password: this.password,
        user_type: this.userType,
      }),
    });

    const location = res.headers.get('location') || '';
    if (res.status !== 302 || !/homePage/i.test(location)) {
      const err = new Error(`EMS login failed (HTTP ${res.status}${location ? ' -> ' + location : ''}). Check username, password and user type.`);
      err.status = res.status;
      throw err;
    }
    if (!this.cookies.has('JSESSIONID')) throw new Error('Login succeeded but no JSESSIONID cookie was returned.');

    this.authenticated = true;
    this.webSessionUrl = new URL(location, `${this.baseUrl}/ems/`).href;
    return { baseUrl: this.baseUrl, sessionId: this.cookies.get('JSESSIONID'), redirectedTo: location };
  }

  /** List EMS customers as parsed XML objects. */
  async listCustomers() {
    const xml = await this.call('/customer.xml');
    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(xml);
    const inst = parsed?.listResponse?.instance ?? [];
    return Array.isArray(inst) ? inst : [inst];
  }

  /** Load the counter customer as an ordered XML document for safe updates. */
  async _serialNumberCustomer() {
    const id = this.nextSerialNumberCustomerId;
    if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id)) {
      throw new Error('Configure a valid next-serial-number-customer-id before accessing the serial number.');
    }
    if (!this.authenticated) throw new Error('Call authenticate() first.');
    const response = await this._fetch(`${this.apiRoot}/customer/${id}.ws`, {
      headers: { Accept: 'application/xml' },
    });
    const xml = await response.text();
    if (response.status === 401 || response.status === 302) {
      const error = new Error('EMS session expired while loading the serial number customer.');
      error.status = 401;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`EMS customer lookup failed: ${response.status} ${response.statusText}`);
      error.status = response.status;
      error.body = xml;
      throw error;
    }
    if (XMLValidator.validate(xml) !== true) throw new Error('EMS returned invalid customer XML.');
    const options = { preserveOrder: true, ignoreAttributes: false, parseTagValue: false, trimValues: false };
    const document = new XMLParser(options).parse(xml);
    const roots = document.filter((node) => Object.hasOwn(node, 'customer'));
    if (roots.length !== 1 || !Array.isArray(roots[0].customer)) throw new Error('EMS returned an invalid customer record.');
    const references = roots[0].customer.filter((node) => Object.hasOwn(node, 'refId'));
    if (references.length !== 1 || !Array.isArray(references[0].refId) ||
        references[0].refId.some((node) => !Object.hasOwn(node, '#text'))) {
      throw new Error('EMS customer must contain exactly one plain-text refId.');
    }
    return { document, reference: references[0], options };
  }

  /** Read the next serial number from the configured customer's JSON Ref ID. */
  async getNextProductKeySerial() {
    const { reference } = await this._serialNumberCustomer();
    const value = reference.refId.map((node) => node['#text']).join('').trim();
    const encodedCounter = /^\{\s*&quot;NextSerial&quot;\s*:\s*&quot;\d{5,6}&quot;\s*\}$/.test(value);
    let counter;
    try {
      counter = JSON.parse(encodedCounter ? value.replace(/&quot;/g, '"') : value);
    } catch {
      throw new Error('The serial number customer has an invalid Ref ID 1; expected a JSON object with a NextSerial value.');
    }
    if (!counter || typeof counter !== 'object' || Array.isArray(counter) ||
        typeof counter.NextSerial !== 'string' || !/^\d{5,6}$/.test(counter.NextSerial)) {
      throw new Error('The serial number customer has an invalid Ref ID 1; expected a JSON object with a padded NextSerial string.');
    }
    const nextSerial = Number(counter.NextSerial);
    if (counter.NextSerial !== String(nextSerial).padStart(5, '0') ||
        nextSerial < 6001 || nextSerial > 65536) {
      throw new Error('The serial number customer has an invalid NextSerial value; expected 06001 to 65536.');
    }
    return nextSerial;
  }

  /** Update only the next-serial counter Ref ID, preserving the rest of the customer XML. */
  async setNextProductKeySerial(nextSerialNumber) {
    if (!Number.isInteger(nextSerialNumber) || nextSerialNumber < 6001 || nextSerialNumber > 65536) {
      throw new Error('Next serial number must be a whole number from 6,001 to 65,536.');
    }
    const { document, reference, options } = await this._serialNumberCustomer();
    reference.refId = [{
      '#text': JSON.stringify({ NextSerial: String(nextSerialNumber).padStart(5, '0') }),
    }];
    // This field contains only generated JSON with decimal digits, so it is safe
    // to send its quotes literally while preserving XML escaping in other fields.
    const body = new XMLBuilder({ ...options, stopNodes: ['customer.refId'] }).build(document);
    const response = await this._fetch(`${this.apiRoot}/customer/${this.nextSerialNumberCustomerId}.ws`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml', Accept: 'application/xml' },
      body,
    });
    const text = await response.text();
    if (response.status === 401 || response.status === 302) {
      const error = new Error('EMS session expired while updating the serial number customer.');
      error.status = 401;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`EMS customer update failed: ${response.status} ${response.statusText}`);
      error.status = response.status;
      error.body = text;
      throw error;
    }
  }

  /** Create an EMS customer and return its Location response header. */
  async createCustomer({ name, vendorId, reference = '', description = '', phone = '' }) {
    if (!this.authenticated) throw new Error('Call authenticate() first.');
    if (!name) throw new Error('Customer name is required.');
    if (!vendorId) throw new Error('EMS vendor ID is required (set EMS_VENDOR_ID in .env).');
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const xml =
      '<customer>' +
      '<type>org</type><enabled>true</enabled>' +
      `<name>${esc(name)}</name><description>${esc(description)}</description>` +
      `<crmId>${esc(reference)}</crmId><refId>${esc(reference)}</refId>` +
      `<phone>${esc(phone)}</phone><vendorId>${esc(vendorId)}</vendorId>` +
      '</customer>';
    const res = await this._fetch(`${this.apiRoot}/customer.ws`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/xml', Accept: 'application/xml' },
      body: xml,
    });
    const text = await res.text();
    if (res.status !== 201) {
      const err = new Error(`EMS PUT /customer.ws failed: ${res.status} ${res.statusText}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    return res.headers.get('location');
  }

  /** List entitlements, preserving leading zeroes in their order codes. */
  async listEntitlements() {
    const xml = await this.call('/entitlement.xml');
    const parsed = new XMLParser({
      ignoreAttributes: false, attributeNamePrefix: '',
      tagValueProcessor: (name, value) => name === 'refId1' ? null : value,
    }).parse(xml);
    const inst = parsed?.listResponse?.instance ?? [];
    return Array.isArray(inst) ? inst : [inst];
  }

  /** Read every entitlement page for activation discovery. */
  async listEntitlementsForActivations() {
    if (!this.authenticated) throw new Error('Call authenticate() first.');
    const entitlements = [];
    const seen = new Set();
    let total;
    for (let page = 1; ; page++) {
      const response = await this._fetch(`${this.apiRoot}/entitlement.ws?pageIndex=${page}&pageSize=100`, {
        headers: { Accept: 'application/xml' },
      });
      if (response.status === 401 || response.status === 302) {
        const error = new Error('EMS session expired while loading entitlements.');
        error.status = 401;
        throw error;
      }
      if (!response.ok) throw new Error(`EMS entitlement list failed: HTTP ${response.status}.`);
      const count = response.headers.get('X-Total-Count');
      if (count === null || !/^\d+$/.test(count) || !Number.isSafeInteger(Number(count))) {
        throw new Error('EMS did not return a valid entitlement count for pagination.');
      }
      if (total !== undefined && total !== Number(count)) throw new Error('EMS entitlement count changed while paging; retry.');
      total = Number(count);
      const xml = await response.text();
      if (XMLValidator.validate(xml) !== true) throw new Error('EMS returned invalid entitlement list XML.');
      const list = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false }).parse(xml)?.listResponse;
      if (list === undefined || list === null || typeof list !== 'object' && list !== '') {
        throw new Error('EMS returned an invalid entitlement list.');
      }
      const instances = !list?.instance ? [] : Array.isArray(list.instance) ? list.instance : [list.instance];
      for (const entry of instances) {
        const id = String(entry?.id ?? entry?.entitlementId ?? '');
        if (!/^[1-9]\d*$/.test(id) || seen.has(id)) throw new Error('EMS returned an invalid or duplicate entitlement ID while paging.');
        seen.add(id);
        entitlements.push(entry);
      }
      if (entitlements.length > total || (!instances.length && entitlements.length < total)) {
        throw new Error('EMS returned an incomplete entitlement list.');
      }
      if (entitlements.length === total) return entitlements;
    }
  }

  /** List enforcement products available to the vendor. */
  async listEnforcements(vendorId = '2') {
    const xml = await this.call(`/enforcement.xml?vendorId=${encodeURIComponent(vendorId)}`);
    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(xml);
    const inst = parsed?.listResponse?.instance ?? [];
    return Array.isArray(inst) ? inst : (inst ? [inst] : []);
  }

  /** Search all catalog pages for products with the given identifier. */
  async listProductsByIdentifier(identifier, vendorId = '2') {
    if (!/^\d+$/.test(String(identifier))) throw new Error('Product identifier must be numeric');
    if (!/^[1-9]\d*$/.test(String(vendorId))) throw new Error('Vendor ID must be a positive number');
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false });
    const pageSize = 100;
    const products = [];
    const seenIds = new Set();
    for (let page = 1; ; page++) {
      const path = `/vendor/${vendorId}/product.ws?identifier=${encodeURIComponent(identifier)}&pageIndex=${page}&pageSize=${pageSize}`;
      let xml;
      try {
        xml = await this.call(path);
      } catch (err) {
        if (err.status === 302) err.status = 401;
        throw err;
      }
      const list = parser.parse(xml)?.listResponse;
      if (!list || typeof list !== 'object') throw new Error('EMS returned an invalid product search result');
      const instances = list.instance === undefined || list.instance === ''
        ? [] : (Array.isArray(list.instance) ? list.instance : [list.instance]);
      if (instances.some((entry) => !entry || typeof entry !== 'object' ||
          !/^[1-9]\d*$/.test(String(entry.id)) || typeof entry.type !== 'string' ||
          !/^\d+$/.test(String(entry.identifier)))) {
        throw new Error('EMS returned an invalid product search entry');
      }
      for (const entry of instances) {
        if (seenIds.has(String(entry.id))) throw new Error('EMS returned duplicate products while paging');
        seenIds.add(String(entry.id));
      }
      products.push(...instances.filter((entry) => String(entry.identifier) === String(identifier)));
      if (instances.length < pageSize) break;
    }
    return products;
  }

  /** Resolve an identifier to exactly one base product, or reject ambiguity. */
  async findBaseProductByIdentifier(identifier, vendorId = '2') {
    const products = await this.listProductsByIdentifier(identifier, vendorId);
    const bases = products.filter((entry) => entry.type.toUpperCase() === 'BASE');
    if (bases.length !== 1) throw new Error(`Expected one base product with identifier ${identifier} in EMS; found ${bases.length}`);
    return bases[0];
  }

  /** Read a product by its internal EMS ID. */
  async getProductSummary(id) {
    if (!/^[1-9]\d*$/.test(String(id))) throw new Error('Product ID must be a positive number');
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false });
    let xml;
    try {
      xml = await this.call(`/product/${id}.ws`);
    } catch (err) {
      if (err.status === 302) err.status = 401;
      throw err;
    }
    const product = parser.parse(xml)?.product;
    if (!product || typeof product !== 'object') throw new Error(`EMS returned invalid details for product ${id}`);
    return {
      id: String(id),
      productName: product.productName,
      lifeCycleStage: product.lifeCycleStage,
      enforcementProductType: product.enforcementProductType,
      productIdentifier: product.productIdentifier,
    };
  }

  /** Return only modifications whose base product matches the supplied ID. */
  async listModificationProducts(productId, vendorId = '2') {
    if (!/^[1-9]\d*$/.test(String(productId))) throw new Error('Product ID must be a positive number');
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false });
    const getXml = async (path) => {
      try {
        return parser.parse(await this.call(path));
      } catch (err) {
        if (err.status === 302) err.status = 401;
        throw err;
      }
    };
    const base = (await getXml(`/product/${productId}.ws`))?.product;
    if (!base || typeof base !== 'object' || !/^\d+$/.test(String(base.productIdentifier))) {
      throw new Error('EMS returned invalid base product details');
    }
    const candidates = (await this.listProductsByIdentifier(base.productIdentifier, vendorId))
      .filter((entry) => entry.type.toUpperCase() === 'MODIFICATION');

    const matches = [];
    for (let i = 0; i < candidates.length; i += 10) {
      const batch = await Promise.all(candidates.slice(i, i + 10).map(async (entry) => {
        const detail = (await getXml(`/product/${entry.id}.ws`))?.product;
        if (!detail || typeof detail !== 'object' || !/^\d+$/.test(String(detail.baseProductId))) {
          throw new Error(`EMS returned invalid details for modification product ${entry.id}`);
        }
        return String(detail.baseProductId) === String(productId) ? {
          productId: entry.id,
          productName: entry.name,
          productIdentifier: entry.identifier,
          lifeCycleStage: entry.lifeCycleStage,
          deployed: entry.deployed,
          description: entry.descr,
        } : null;
      }));
      matches.push(...batch.filter(Boolean));
    }
    return matches;
  }

  /** Load the product's read-only static and dynamic memory segments. */
  async getProductReadOnlyMemory(id) {
    if (!/^[1-9]\d*$/.test(String(id))) throw new Error('Product ID must be a positive number');
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false });
    const getXml = async (path) => {
      try {
        return await this.call(path);
      } catch (err) {
        if (err.status === 302) err.status = 401;
        throw err;
      }
    };
    const product = parser.parse(await getXml(`/product/${id}.ws`))?.product;
    if (!product || typeof product !== 'object') throw new Error('EMS returned invalid product details');

    const asList = (value) => value === undefined || value === '' ? [] : (Array.isArray(value) ? value : [value]);
    const segmentFields = ({ id, name, description, offset, size, content, text, saot }) => {
      if (!['true', 'false', '1', '0'].includes(String(saot).toLowerCase())) {
        throw new Error('EMS returned a memory segment without a valid SAOT flag');
      }
      return {
        id, name, description, offset, size, content: content ?? text,
        saot: ['true', '1'].includes(String(saot).toLowerCase()),
      };
    };
    const staticSegments = asList(product.memorySegment).filter((segment) => {
      if (!segment || typeof segment !== 'object') throw new Error('EMS returned an invalid product memory segment');
      const types = asList(segment.memoryType);
      if (!types.length || types.some((type) => !type || !['1', '2'].includes(String(type.id)))) {
        throw new Error('EMS returned a product memory segment without a valid memory type');
      }
      return types.some((type) => String(type.id) === '2');
    }).map(segmentFields);
    const staticFiles = staticSegments.length ? [{ kind: 'product', segments: staticSegments }] : [];
    const references = asList(product.dynamicMemoriesRef);
    const memories = references.flatMap((refs) => {
      if (!refs || typeof refs !== 'object') throw new Error('EMS returned invalid product memory references');
      return asList(refs.dynamicMemory);
    });

    const files = await Promise.all(memories.map(async (reference) => {
      if (!reference || typeof reference !== 'object' || !/^[1-9]\d*$/.test(String(reference.memoryId))) {
        throw new Error('EMS returned an invalid product memory ID');
      }
      const memory = parser.parse(await getXml(`/dynamicMemory/${reference.memoryId}.ws`))?.dynamicMemory;
      if (!memory || typeof memory !== 'object' || !['1', '2'].includes(String(memory.memoryType))) {
        throw new Error(`EMS returned invalid details for memory ${reference.memoryId}`);
      }
      if (String(memory.memoryType) !== '2') return null;

      const container = reference.memories === undefined ? memory.memories : reference.memories;
      if (container !== undefined && container !== '' && (!container || typeof container !== 'object')) {
        throw new Error(`EMS returned invalid segments for memory ${reference.memoryId}`);
      }
      const segments = container && container.memorySegment;
      const segmentList = asList(segments);
      if (segmentList.some((segment) => !segment || typeof segment !== 'object')) {
        throw new Error(`EMS returned invalid segments for memory ${reference.memoryId}`);
      }
      return {
        kind: 'dynamic',
        memoryId: String(reference.memoryId),
        memoryName: memory.memoryName,
        fileId: memory.fileId,
        segments: segmentList.map(segmentFields),
      };
    }));
    return [...staticFiles, ...files.filter(Boolean)];
  }

  /** Parse an entitlement and merge its saved segment values with product metadata. */
  async getEntitlementDetails(id, { includeCustomer = true } = {}) {
    const xml = await this.getEntitlement(id);
    const parsed = new XMLParser({
      ignoreAttributes: false, attributeNamePrefix: '',
      tagValueProcessor: (name, value) =>
        ['refId1', 'productKeyId', 'data', 'text', 'content'].includes(name) ? null : value,
    }).parse(xml);
    const entitlement = parsed?.entitlement;
    if (!entitlement || typeof entitlement !== 'object') {
      throw new Error('EMS returned an invalid entitlement detail');
    }

    const customers = includeCustomer ? await this.listCustomers() : [];
    const customer = customers.find((entry) =>
      String(entry.customerId ?? entry.id ?? '') === String(entitlement.customerId ?? '')
    );
    const items = entitlement.entitlementItem ?? [];
    const asList = (value) => value === undefined || value === '' ? [] : (Array.isArray(value) ? value : [value]);
    const entitlementItems = Array.isArray(items) ? items : [items];
    const products = entitlementItems.flatMap((item) => {
      const itemProducts = item?.itemProduct ?? [];
      const productList = Array.isArray(itemProducts) ? itemProducts : [itemProducts];
      const entitlementMemorySegments = asList(
        item?.memorySegments?.segment ?? item?.memorySegments?.memorySegment ?? item?.memorySegments
      );
      return productList.filter((product) => product && typeof product === 'object').map((product) => ({
        lineItemType: item?.lineItemType,
        productId: product.productId,
        productName: product.product?.productName ?? product.productName,
        memorySegments: asList(product.product?.memorySegment)
          .filter((segment) => segment && typeof segment === 'object')
          .map((segment) => {
            const entitlementSegment = entitlementMemorySegments.find((memorySegment) =>
              String(memorySegment.prdMemorySegmentId ?? memorySegment.productMemorySegmentId ?? '') === String(segment.id)
            );
            const text = entitlementSegment?.data ?? entitlementSegment?.text ??
              entitlementSegment?.content ?? segment.text ?? segment.content;
            return {
              id: String(segment.id),
              name: segment.name,
              saot: ['true', '1'].includes(String(segment.saot).toLowerCase()),
              memoryTypes: asList(segment.memoryType).map((type) => String(type?.id ?? '')),
              size: segment.size,
              offset: segment.offset,
              text: text === undefined || text === null ? '' : String(text),
            };
          }),
      }));
    });

    return {
      ...entitlement,
      id: String(id),
      customerName: customer?.name ?? customer?.customerName ?? entitlement.customer,
      lineItemTypes: entitlementItems.map((item) => item?.lineItemType),
      products,
    };
  }

  /** Load and verify the product keys of a generated or completed entitlement. */
  async getEntitlementProductKeys(id) {
    const entitlement = await this.getEntitlementDetails(id);
    const state = String(entitlement.entState ?? '').toUpperCase();
    if (!['PRODUCT_KEY_GENERATED', 'COMPLETED'].includes(state)) {
      const error = new Error('Product keys are only available for generated or completed entitlements.');
      error.status = 400;
      throw error;
    }
    return this._getEntitlementProductKeys(id, entitlement, false, state === 'COMPLETED');
  }

  /** Find existing product keys regardless of entitlement state for activation discovery. */
  async getProductKeysForActivations(id) {
    const entitlement = await this.getEntitlementDetails(id, { includeCustomer: false });
    return this._getEntitlementProductKeys(id, entitlement, true);
  }

  async _getEntitlementProductKeys(id, entitlement, existingOnly, includeUpdates = false) {
    const items = Array.isArray(entitlement.entitlementItem) ? entitlement.entitlementItem : [entitlement.entitlementItem];
    const ids = items.flatMap((item) => {
      if (existingOnly && (!item || !(item.lineItemType === 'Product_Key' ||
          includeUpdates && item.lineItemType === 'ProtectionKey_Update') || !item.productKeyId)) return [];
      if (existingOnly) return Array.isArray(item.productKeyId) ? item.productKeyId : [item.productKeyId];
      if (!item || !(item.lineItemType === 'Product_Key' ||
          includeUpdates && item.lineItemType === 'ProtectionKey_Update') || !item.productKeyId) {
        throw new Error('EMS did not return a product key ID for every entitlement item.');
      }
      return Array.isArray(item.productKeyId) ? item.productKeyId : [item.productKeyId];
    });
    if ((!existingOnly && !ids.length) || ids.some((key) => typeof key !== 'string' || !key.trim())) {
      throw new Error('EMS returned an invalid product key ID.');
    }
    return Promise.all([...new Set(ids)].map(async (key) => {
      const response = await this._fetch(`${this.apiRoot}/productKey/${encodeURIComponent(key)}.ws`, {
        headers: { Accept: 'application/xml' },
      });
      const xml = await response.text();
      if (response.status === 401 || response.status === 302) {
        const error = new Error('EMS session expired while loading product key details.');
        error.status = 401;
        throw error;
      }
      if (!response.ok) throw new Error(`EMS product key lookup failed: ${response.status} ${response.statusText}`);
      if (XMLValidator.validate(xml) !== true) throw new Error('EMS returned invalid product key XML.');
      const productKey = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false }).parse(xml).productKey;
      if (!productKey || typeof productKey !== 'object' ||
          productKey.productKeyId !== key || String(productKey.entitlementId) !== String(id)) {
        throw new Error('EMS returned product key details for an unexpected key or entitlement.');
      }
      const asList = (value) => value === undefined || value === '' ? [] : Array.isArray(value) ? value : [value];
      return {
        ...productKey,
        productInfo: asList(productKey.productInfo),
        activationAttribute: asList(productKey.activationAttribute),
        activationIds: findActivationIds(productKey),
        activationReferences: findActivationReferences(
          new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false }).parse(xml).productKey
        ),
      };
    }));
  }

  /** List the entitlements EMS associates with a protection key. */
  async getProtectionKeyEntitlements(protectionKeyId) {
    const response = await this._fetch(`${this.apiRoot}/target/${encodeURIComponent(protectionKeyId)}/entitlement.ws`, {
      headers: { Accept: 'application/xml' },
    });
    if (response.status === 401 || response.status === 302) {
      const error = new Error('EMS session expired while loading protection key entitlements.');
      error.status = 401;
      throw error;
    }
    if (!response.ok) throw new Error(`EMS protection key entitlement lookup failed: HTTP ${response.status}.`);
    const xml = await response.text();
    if (XMLValidator.validate(xml) !== true) throw new Error('EMS returned invalid protection key entitlement XML.');
    const document = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false }).parse(xml);
    const root = document?.entitlementListResponse !== undefined ? 'entitlementListResponse' :
      document?.listResponse !== undefined ? 'listResponse' : null;
    const list = root ? document[root] : null;
    const headerCount = response.headers?.get('X-Total-Count');
    const count = list?.count ?? headerCount;
    if (!list || typeof list !== 'object' || !/^\d+$/.test(count ?? '') ||
        !Number.isSafeInteger(Number(count))) {
      const knownRoots = ['entitlementListResponse', 'listResponse', 'ProtectionKey', 'activation', 'error', 'html'];
      const observedRoot = knownRoots.find((name) => Object.hasOwn(document, name)) || 'other';
      const countStatus = count == null ? 'missing' : /^\d+$/.test(count) ? 'out of range' : 'non-numeric';
      const fields = list && typeof list === 'object'
        ? ['count', 'entitlementInstance', 'instance'].filter((name) => Object.hasOwn(list, name)).join(',') || 'none'
        : 'unavailable';
      throw new Error(`EMS returned an invalid protection key entitlement list (root: ${observedRoot}; count: ${countStatus}; recognized fields: ${fields}).`);
    }
    const instances = root === 'entitlementListResponse' ? list.entitlementInstance : list.instance;
    const entries = instances === undefined ? [] : Array.isArray(instances) ? instances : [instances];
    const ids = entries.map((entry) => root === 'entitlementListResponse' ? entry?.entId : entry?.id);
    if (headerCount != null && (!/^\d+$/.test(headerCount) || Number(headerCount) !== Number(count)) ||
        ids.length !== Number(count) || ids.some((id) => !/^[1-9]\d*$/.test(id ?? '')) ||
        new Set(ids).size !== ids.length) {
      throw new Error('EMS returned an incomplete or invalid protection key entitlement list.');
    }
    return ids;
  }

  /** Find existing product keys, including those for protection-key updates. */
  async getProtectionKeyActivationCandidates(entitlementId) {
    const entitlement = await this.getEntitlementDetails(entitlementId, { includeCustomer: false });
    const items = Array.isArray(entitlement.entitlementItem) ? entitlement.entitlementItem : [entitlement.entitlementItem];
    const missingUpdateProductKey = items.some((item) =>
      item?.lineItemType === 'ProtectionKey_Update' && !item.productKeyId);
    const keys = await this._getEntitlementProductKeys(entitlementId, entitlement, true, true);
    return { keys, missingUpdateProductKey };
  }

  /** Get the counter in the key state EMS associates with an activation. */
  async getActivationUpdateCounter(protectionKeyId, aid) {
    const response = await this._fetch(`${this.apiRoot}/target/${encodeURIComponent(protectionKeyId)}/activation.ws?AID=${encodeURIComponent(aid)}`, {
      headers: { Accept: 'application/xml' },
    });
    if (response.status === 401 || response.status === 302) {
      const error = new Error('EMS session expired while loading activation key history.');
      error.status = 401;
      throw error;
    }
    if (!response.ok) throw new Error(`EMS key history lookup failed: HTTP ${response.status}.`);
    const xml = await response.text();
    if (XMLValidator.validate(xml) !== true) throw new Error('EMS returned invalid key history XML.');
    const parser = new XMLParser({ parseTagValue: false });
    const document = parser.parse(xml);
    const updateInfo = document?.ProtectionKey?.ProtectionKeyOutput?.UpdateInfo;
    const wrapped = typeof updateInfo === 'string' && XMLValidator.validate(updateInfo.trim()) === true
      ? parser.parse(updateInfo.trim()) : updateInfo;
    const key = document?.sentinel_ldk_info?.key ??
      document?.ProtectionKey?.ProtectionKeyOutput?.C2V?.sentinel_ldk_info?.key ??
      wrapped?.sentinel_ldk_info?.key;
    if (String(key?.id ?? '').trim() !== protectionKeyId ||
        typeof key?.update_counter !== 'string' || !/^\d+$/.test(key.update_counter.trim())) {
      const knownRoots = ['sentinel_ldk_info', 'ProtectionKey', 'activation', 'listResponse', 'error', 'html'];
      const root = knownRoots.find((name) => Object.hasOwn(document, name)) || 'other';
      const wrapper = updateInfo === undefined ? 'missing' : typeof updateInfo === 'string' ? 'text' : 'nested';
      const idStatus = key?.id == null || key.id === '' ? 'missing' :
        String(key.id).trim() === protectionKeyId ? 'matches' : 'different or non-text';
      const counterStatus = key?.update_counter == null || key.update_counter === '' ? 'missing' :
        typeof key.update_counter === 'string' && /^\d+$/.test(key.update_counter.trim()) ? 'numeric' : 'invalid';
      throw new Error(`EMS returned an invalid or unexpected key history (root: ${root}; UpdateInfo: ${wrapper}; key: ${key ? 'present' : 'missing'}; key ID: ${idStatus}; update counter: ${counterStatus}).`);
    }
    return key.update_counter.trim();
  }

  /** Fetch the pending update package for the protection key described by a C2V. */
  async fetchPendingUpdates(c2v) {
    if (typeof c2v !== 'string' || XMLValidator.validate(c2v) !== true) {
      const error = new Error('The C2V file must contain valid XML.');
      error.status = 400;
      throw error;
    }
    const input = new XMLParser({ parseTagValue: false }).parse(c2v)?.hasp_info;
    if (!input || typeof input !== 'object' || !input.haspscope || !input.c2v) {
      const error = new Error('The C2V file must contain hasp_info, haspscope and c2v.');
      error.status = 400;
      throw error;
    }
    const response = await fetch(`${this.apiRoot}/activation/target.ws`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/xml', Accept: 'application/xml' },
      body: c2v,
    });
    if (response.status === 404) {
      const error = new Error('EMS returned HTTP 404 for this C2V; the pending updates request failed.');
      error.status = 404;
      throw error;
    }
    if (!response.ok) {
      throw new Error(`EMS pending updates request failed: HTTP ${response.status}${response.statusText ? ' ' + response.statusText : ''}. If EMS is unavailable or busy, retry later.`);
    }
    const xml = await response.text();
    if (XMLValidator.validate(xml) !== true) throw new Error('EMS returned invalid pending update XML.');
    const output = new XMLParser({ parseTagValue: false }).parse(xml)?.hasp_info;
    const payload = typeof output?.v2cp === 'string' ? output.v2cp.replace(/\s/g, '') : '';
    if (!payload || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) {
      throw new Error('EMS did not return a valid V2CP package.');
    }
    return xml;
  }

  /**
   * Submit a C2V and return the Activation ID and V2C.
   * Errors after submission carry outcomeUnknown when activation may have succeeded.
   */
  async activateProductKey(key, c2v) {
    if (!this.authenticated) throw new Error('Call authenticate() first.');
    if (typeof key !== 'string' || !key.trim()) throw new Error('Product key is required.');
    const validation = typeof c2v === 'string' && c2v.trim() ? XMLValidator.validate(c2v) : null;
    if (validation !== true) {
      const location = validation?.err ? ` ${validation.err.msg} (line ${validation.err.line}, column ${validation.err.col}).` : '';
      const error = new Error('The C2V file must contain valid XML.' + location);
      error.status = 400;
      throw error;
    }

    const body = '<activation><activationInput><activationAttribute><attributeValue><![CDATA[' +
      c2v.replace(/]]>/g, ']]]]><![CDATA[>') +
      ']]></attributeValue><attributeName>C2V</attributeName></activationAttribute></activationInput></activation>';
    try {
      const response = await this._fetch(`${this.apiRoot}/productKey/${encodeURIComponent(key)}/activation.ws`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml', Accept: 'application/xml' },
        body,
      });
      if (!response.ok) {
        const status = `HTTP ${response.status}${response.statusText ? ' ' + response.statusText : ''}`;
        let responseText;
        try {
          responseText = await response.text();
        } catch (err) {
          const error = new Error(`EMS activation returned ${status}, but its error response could not be read: ${err.message}`);
          if (response.status === 404) {
            error.status = 400;
            error.activationRejected = true;
          }
          throw error;
        }
        const detail = activationErrorDetail(responseText, c2v, [key, this.username, this.password]);
        const error = new Error(`EMS activation returned ${status}.` +
          (response.status === 404 ? ' The product key does not exist in EMS.' : '') +
          (response.status === 401 || response.status === 302 ? ' The EMS session may have expired.' : '') +
          (detail ? ` EMS response: ${detail}` : ' EMS did not provide readable error details.'));
        if (response.status === 404) {
          error.status = 400;
          error.activationRejected = true;
        }
        throw error;
      }
      const xml = await response.text();
      if (XMLValidator.validate(xml) !== true) throw new Error('EMS returned invalid activation XML.');
      const output = new XMLParser({ parseTagValue: false, trimValues: false }).parse(xml)?.activation?.activationOutput;
      const aid = output?.AID;
      const license = output?.activationString;
      if (typeof aid !== 'string' || !aid.trim() || typeof license !== 'string' ||
          !license.trim() || XMLValidator.validate(license.trim()) !== true ||
          !new XMLParser({ parseTagValue: false }).parse(license.trim())?.hasp_info?.v2c) {
        throw new Error('EMS did not return a valid V2C and Activation ID.');
      }
      return { aid: aid.trim(), license };
    } catch (err) {
      if (err.activationRejected) throw err;
      const cause = err.cause?.code ? ` (${err.cause.code})` : '';
      const error = new Error(`Activation outcome is unknown: ${err.message}${cause}`);
      error.outcomeUnknown = true;
      throw error;
    }
  }

  /** Fetch an activation document from EMS and verify its Activation ID. */
  async _getActivationXml(aid) {
    if (typeof aid !== 'string' || !aid.trim()) throw new Error('Activation ID is required');
    const response = await this._fetch(`${this.apiRoot}/activation/${encodeURIComponent(aid)}.ws`, {
      headers: { Accept: 'application/xml' },
    });
    const xml = await response.text();
    if (response.status === 401 || response.status === 302) {
      const error = new Error('EMS session expired while loading activation details.');
      error.status = 401;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`EMS activation lookup failed: ${response.status} ${response.statusText}`);
      error.status = response.status;
      error.body = xml;
      throw error;
    }
    if (XMLValidator.validate(xml) !== true) throw new Error('EMS returned invalid activation XML.');
    return xml;
  }

  /** Read an existing activation and verify the returned Activation ID. */
  async getActivationLicense(aid) {
    const xml = await this._getActivationXml(aid);
    const activation = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      parseTagValue: false,
      trimValues: false,
    }).parse(xml)?.activation;
    const output = activation?.activationOutput;
    if (!output || typeof output !== 'object' ||
        String(output.AID ?? output.aid ?? output.activationId ?? '').trim() !== aid) {
      throw new Error('EMS returned activation details for an unexpected Activation ID.');
    }
    return {
      aid,
      protectionKeyId: output.protectionKeyId,
      activationString: output.activationString,
    };
  }

  /** Read the C2V stored with an activation record, without exposing it to the browser. */
  async getActivationC2V(aid) {
    const xml = await this._getActivationXml(aid);
    const options = {
      preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '',
      parseTagValue: false, trimValues: false,
    };
    const document = new XMLParser(options).parse(xml);
    const roots = document.filter((node) => Object.hasOwn(node, 'activation'));
    if (roots.length !== 1 || !Array.isArray(roots[0].activation)) {
      throw new Error('EMS returned an invalid activation record.');
    }
    const fields = roots[0].activation;
    const textOf = (nodes, name) => {
      const matches = nodes.filter((node) => Object.hasOwn(node, name));
      if (matches.length !== 1 || !Array.isArray(matches[0][name]) ||
          matches[0][name].some((node) => !Object.hasOwn(node, '#text'))) return null;
      return matches[0][name].map((node) => String(node['#text'])).join('');
    };
    const output = fields.find((node) => Object.hasOwn(node, 'activationOutput'))?.activationOutput;
    if (!Array.isArray(output) || textOf(output, 'AID')?.trim() !== aid) {
      throw new Error('EMS returned activation details for an unexpected Activation ID.');
    }
    const inputs = fields.filter((node) => Object.hasOwn(node, 'activationInput'));
    if (inputs.length !== 1 || !Array.isArray(inputs[0].activationInput)) {
      throw new Error(`EMS activation record does not contain one usable activationInput (found ${inputs.length}).`);
    }
    const attributes = inputs[0].activationInput
      .filter((node) => Object.hasOwn(node, 'activationAttribute'))
      .map((node) => node.activationAttribute)
      .filter(Array.isArray);
    const c2vAttributes = attributes.filter((attribute) =>
      textOf(attribute, 'attributeName')?.trim().toUpperCase() === 'C2V'
    );
    if (c2vAttributes.length !== 1) {
      throw new Error(`EMS activation record must contain exactly one saved C2V attribute (found ${c2vAttributes.length} among ${attributes.length} activation attributes).`);
    }
    const valueElements = c2vAttributes[0].filter((node) => Object.hasOwn(node, 'attributeValue'));
    if (valueElements.length !== 1) throw new Error(`EMS C2V attribute must contain one attributeValue (found ${valueElements.length}).`);
    const valueNodes = valueElements[0].attributeValue;
    if (!Array.isArray(valueNodes)) throw new Error('EMS activation record does not contain a saved C2V value.');
    const textOnly = valueNodes.every((node) => Object.hasOwn(node, '#text'));
    let c2v = textOnly
      ? valueNodes.map((node) => String(node['#text'])).join('').trim()
      : new XMLBuilder(options).build(valueNodes).trim();
    const escapedXml = textOnly && c2v.match(/^(<\?xml\s[^?]*\?>\s*)(&lt;hasp_info(?:\s|&gt;)[\s\S]*)$/);
    let decodedEscapedXml = false;
    if (escapedXml && !escapedXml[2].includes('<') &&
        XMLValidator.validate(`<value>${escapedXml[2]}</value>`) === true) {
      const decoded = new XMLParser({ parseTagValue: false, trimValues: false }).parse(`<value>${escapedXml[2]}</value>`).value;
      if (typeof decoded === 'string') {
        c2v = escapedXml[1] + decoded;
        decodedEscapedXml = true;
      }
    }
    if (textOnly) {
      // Character references outside the root are not XML whitespace until decoded.
      c2v = c2v.replace(/^(<\?xml\s[^?]*\?>)((?:[ \t\r\n]|&#x[dD];)+)(?=<)/,
        (_, declaration, whitespace) => declaration + whitespace.replace(/&#x[dD];/g, '\r'));
      c2v = c2v.replace(/(>)((?:[ \t\r\n]|&#x[dD];)*&#x[dD];(?:[ \t\r\n]|&#x[dD];)*)$/,
        (_, closing, whitespace) => closing + whitespace.replace(/&#x[dD];/g, '\r'));
    }
    const format = textOnly ? 'text' : 'nested XML';
    const size = Buffer.byteLength(c2v, 'utf8');
    if (!c2v || c2v.toLowerCase() === 'null') {
      throw new Error(`EMS activation record has ${c2v ? 'a null' : 'an empty'} C2V value (format: ${format}; size: ${size} bytes).`);
    }
    const validation = XMLValidator.validate(c2v);
    if (validation !== true) {
      const code = /^[A-Za-z]+$/.test(validation.err.code) ? validation.err.code : 'unknown';
      const line = Number.isInteger(validation.err.line) ? validation.err.line : 'unknown';
      const column = Number.isInteger(validation.err.col) ? validation.err.col : 'unknown';
      const error = new Error(`EMS activation record contains an invalid saved C2V (format: ${format}; size: ${size} bytes; XML error: ${code}, line ${line}, column ${column}).`);
      error.c2vDiagnostic = {
        format,
        sizeBytes: size,
        xmlError: code,
        line,
        column,
        reason: validation.err.msg === "char '&' is not expected." ? 'unexpected ampersand' : 'XML validation failed',
        startsWithXmlDeclaration: /^<\?xml(?:\s|\?)/i.test(c2v),
        containsHASPInfoMarkup: /<hasp_info(?:\s|>|\/)/i.test(c2v),
        containsEscapedHASPInfoMarkup: /&lt;hasp_info(?:\s|&gt;|\/)/i.test(c2v),
        extraEscapingDetected: Boolean(escapedXml),
        extraEscapingDecoded: decodedEscapedXml,
      };
      throw error;
    }
    return c2v;
  }

  /** Build the EMS entitlement XML for the requested products and memory values. */
  buildEntitlementXml(entitlement) {
    return buildEntitlementXml(entitlement);
  }

  /** Produce a draft and confirm the resulting EMS state; uncertain outcomes must not be retried blindly. */
  async produceEntitlement(id) {
    if (!this.authenticated) throw new Error('Call authenticate() first.');
    if (!/^[1-9]\d*$/.test(String(id))) throw new Error('Entitlement id must be a positive number.');
    const path = `${this.apiRoot}/entitlement/${id}.xml`;
    const response = await this._fetch(path, { headers: { Accept: 'application/xml' } });
    const xml = await response.text();
    if (response.status === 401 || response.status === 302) {
      const error = new Error('EMS session expired while loading the entitlement.');
      error.status = 401;
      throw error;
    }
    if (!response.ok) throw new Error(`EMS entitlement lookup failed: ${response.status} ${response.statusText}`);
    if (XMLValidator.validate(xml) !== true) throw new Error('EMS returned invalid entitlement XML.');
    const parsed = new XMLParser({ parseTagValue: false }).parse(xml).entitlement;
    const items = parsed?.entitlementItem;
    const itemList = Array.isArray(items) ? items : items ? [items] : [];
    if (String(parsed?.entState ?? '').toUpperCase() !== 'DRAFT' ||
        !itemList.length || itemList.some((item) => item?.lineItemType !== 'Product_Key')) {
      const error = new Error('Only draft Product Key entitlements can be produced.');
      error.status = 400;
      throw error;
    }
    const options = {
      preserveOrder: true, ignoreAttributes: false, parseTagValue: false, trimValues: false,
      commentPropName: '#comment', cdataPropName: '#cdata',
    };
    const document = new XMLParser(options).parse(xml);
    const roots = document.filter((node) => Object.hasOwn(node, 'entitlement'));
    if (roots.length !== 1 || !Array.isArray(roots[0].entitlement)) throw new Error('EMS returned invalid entitlement XML.');
    const fields = roots[0].entitlement;
    if (fields.some((node) => Object.hasOwn(node, 'action'))) throw new Error('EMS returned an unexpected entitlement action.');
    const enabledIndex = fields.findIndex((node) => Object.hasOwn(node, 'enabled'));
    fields.splice(enabledIndex + 1, 0, { action: [{ '#text': 'PRODUCE' }] });
    const body = new XMLBuilder(options).build(document);
    let confirmedState;
    try {
      const update = await this._fetch(`${this.apiRoot}/entitlement/${id}.ws`, {
        method: 'POST',
        headers: { Accept: 'application/xml, application/json', 'Content-Type': 'application/xml' },
        body,
      });
      if (!update.ok) throw new Error(`EMS returned ${update.status} ${update.statusText}`);
      const check = await this._fetch(path, { headers: { Accept: 'application/xml' } });
      const checkXml = await check.text();
      if (!check.ok || XMLValidator.validate(checkXml) !== true) {
        throw new Error('EMS did not confirm the produced state');
      }
      confirmedState = String(new XMLParser({ parseTagValue: false }).parse(checkXml).entitlement?.entState ?? '').toUpperCase();
      if (!['PRODUCED', 'PRODUCT_KEY_GENERATED'].includes(confirmedState)) {
        throw new Error(`EMS did not confirm the produced state (current state: ${confirmedState || 'unavailable'})`);
      }
    } catch (err) {
      const error = new Error(`The result of producing entitlement ${id} is unknown: ${err.message}.`);
      error.outcomeUnknown = true;
      throw error;
    }
    return { produced: true, entId: String(id), state: confirmedState };
  }

  /** Reopen an eligible entitlement and confirm it returned to draft state. */
  async reopenEntitlement(id) {
    if (!this.authenticated) throw new Error('Call authenticate() first.');
    if (!/^[1-9]\d*$/.test(String(id))) throw new Error('Entitlement id must be a positive number.');
    const path = `${this.apiRoot}/entitlement/${id}.xml`;
    const response = await this._fetch(path, { headers: { Accept: 'application/xml' } });
    const xml = await response.text();
    if (response.status === 401 || response.status === 302) {
      const error = new Error('EMS session expired while loading the entitlement.');
      error.status = 401;
      throw error;
    }
    if (!response.ok) throw new Error(`EMS entitlement lookup failed: ${response.status} ${response.statusText}`);
    if (XMLValidator.validate(xml) !== true) throw new Error('EMS returned invalid entitlement XML.');
    const parsed = new XMLParser({ parseTagValue: false }).parse(xml).entitlement;
    const items = parsed?.entitlementItem;
    const itemList = Array.isArray(items) ? items : items ? [items] : [];
    if (!['PRODUCT_KEY_GENERATED', 'QUEUED'].includes(String(parsed?.entState ?? '').toUpperCase()) ||
        !itemList.length || itemList.some((item) => item?.lineItemType !== 'Product_Key')) {
      const error = new Error('Only queued or Product Key generated entitlements can be reopened.');
      error.status = 400;
      throw error;
    }
    const options = {
      preserveOrder: true, ignoreAttributes: false, parseTagValue: false, trimValues: false,
      commentPropName: '#comment', cdataPropName: '#cdata',
    };
    const document = new XMLParser(options).parse(xml);
    const roots = document.filter((node) => Object.hasOwn(node, 'entitlement'));
    if (roots.length !== 1 || !Array.isArray(roots[0].entitlement)) {
      throw new Error('EMS returned invalid entitlement XML.');
    }
    const fields = roots[0].entitlement;
    if (fields.some((node) => Object.hasOwn(node, 'action'))) {
      throw new Error('EMS returned an unexpected entitlement action.');
    }
    const enabledIndex = fields.findIndex((node) => Object.hasOwn(node, 'enabled'));
    if (enabledIndex < 0) throw new Error('EMS returned an entitlement without an enabled field.');
    fields.splice(enabledIndex + 1, 0, { action: [{ '#text': 'REOPEN' }] });
    const body = new XMLBuilder(options).build(document);
    let confirmedState;
    try {
      const update = await this._fetch(`${this.apiRoot}/entitlement/${id}.ws`, {
        method: 'POST',
        headers: { Accept: 'application/xml, application/json', 'Content-Type': 'application/xml' },
        body,
      });
      if (!update.ok) throw new Error(`EMS returned ${update.status} ${update.statusText}`);
      const check = await this._fetch(path, { headers: { Accept: 'application/xml' } });
      const checkXml = await check.text();
      if (!check.ok || XMLValidator.validate(checkXml) !== true) {
        throw new Error('EMS did not confirm the reopened state');
      }
      confirmedState = String(new XMLParser({ parseTagValue: false }).parse(checkXml).entitlement?.entState ?? '').toUpperCase();
      if (confirmedState !== 'DRAFT') {
        throw new Error(`EMS did not confirm the reopened state (current state: ${confirmedState || 'unavailable'})`);
      }
    } catch (err) {
      const error = new Error(`The result of reopening entitlement ${id} is unknown: ${err.message}.`);
      error.outcomeUnknown = true;
      throw error;
    }
    return { reopened: true, entId: String(id), state: confirmedState };
  }

  /** Update editable fields in an existing draft while preserving unrelated XML. */
  async updateEntitlement(id, entitlement) {
    if (!this.authenticated) throw new Error('Call authenticate() first.');
    if (!/^[1-9]\d*$/.test(String(id)) || !entitlement.eid) throw new Error('Entitlement id and eid are required.');
    if (!Array.isArray(entitlement.editableProductIds) || !Array.isArray(entitlement.changedMemorySegmentIds)) {
      throw new Error('Editable product and memory configuration is required.');
    }
    const xml = await this.getEntitlement(id);
    if (XMLValidator.validate(xml) !== true) throw new Error('EMS returned invalid entitlement XML.');
    const parsed = new XMLParser({ parseTagValue: false }).parse(xml).entitlement;
    if (String(parsed?.entState ?? '').toUpperCase() !== 'DRAFT' || parsed.eid !== entitlement.eid) {
      throw new Error('The entitlement is no longer the expected draft; reload it before saving.');
    }
    const options = {
      preserveOrder: true, ignoreAttributes: false, parseTagValue: false, trimValues: false,
      commentPropName: '#comment', cdataPropName: '#cdata',
    };
    const document = new XMLParser(options).parse(xml);
    const roots = document.filter((node) => Object.hasOwn(node, 'entitlement'));
    if (roots.length !== 1 || !Array.isArray(roots[0].entitlement)) throw new Error('EMS returned invalid entitlement XML.');
    const fields = roots[0].entitlement;
    const nodes = (list, name) => list.filter((node) => Object.hasOwn(node, name));
    const textOf = (list, name) => {
      const found = nodes(list, name);
      if (found.length !== 1 || !Array.isArray(found[0][name])) return null;
      const parts = found[0][name];
      if (parts.some((part) => !Object.hasOwn(part, '#text'))) return null;
      return parts.map((part) => String(part['#text'])).join('').trim();
    };
    const setText = (list, name, value) => {
      const found = nodes(list, name);
      if (found.length > 1) throw new Error(`EMS returned ambiguous ${name}.`);
      const node = found[0] || { [name]: [] };
      node[name] = [{ '#text': String(value) }];
      if (!found.length) list.push(node);
    };
    const itemNodes = nodes(fields, 'entitlementItem');
    if (itemNodes.length !== 1 || !Array.isArray(itemNodes[0].entitlementItem) ||
        textOf(itemNodes[0].entitlementItem, 'lineItemType') !== 'Product_Key') {
      throw new Error('This draft has unsupported entitlement items; edit it in EMS instead.');
    }
    if (nodes(fields, 'action').length) throw new Error('EMS returned an unexpected entitlement action.');
    const enabledIndex = fields.findIndex((node) => Object.hasOwn(node, 'enabled'));
    fields.splice(enabledIndex + 1, 0, { action: [{ '#text': 'Save' }] });
    setText(fields, 'customerId', entitlement.customerId);
    setText(fields, 'description', entitlement.description);
    if (entitlement.refId1 !== undefined) setText(fields, 'refId1', entitlement.refId1);
    if (entitlement.refId2 !== undefined) setText(fields, 'refId2', entitlement.refId2);
    const itemFields = itemNodes[0].entitlementItem;
    const editable = new Set(entitlement.editableProductIds.map(String));
    const selected = new Set(entitlement.productIds.map(String));
    const originalProducts = nodes(itemFields, 'itemProduct');
    const productIds = originalProducts.map((node) => Array.isArray(node.itemProduct) && textOf(node.itemProduct, 'productId'));
    if (productIds.some((productId) => !productId) || new Set(productIds).size !== productIds.length) {
      throw new Error('EMS returned ambiguous entitlement products.');
    }
    for (let index = originalProducts.length - 1; index >= 0; index--) {
      if (editable.has(productIds[index]) && !selected.has(productIds[index])) {
        itemFields.splice(itemFields.indexOf(originalProducts[index]), 1);
      }
    }
    for (const productId of selected) {
      if (!productIds.includes(productId)) {
        const products = nodes(itemFields, 'itemProduct');
        const lastIndex = products.length ? itemFields.indexOf(products[products.length - 1]) : itemFields.length - 1;
        itemFields.splice(lastIndex + 1, 0, { itemProduct: [
          { isRevoked: [{ '#text': 'false' }] },
          { productId: [{ '#text': productId }] },
        ] });
      }
    }
    const memoryNodes = nodes(itemFields, 'memorySegments');
    if (memoryNodes.length > 1 || (memoryNodes.length && !Array.isArray(memoryNodes[0].memorySegments))) {
      throw new Error('EMS returned ambiguous entitlement memory segments.');
    }
    const memory = memoryNodes.length ? memoryNodes[0].memorySegments : [];
    const removed = originalProducts.filter((node, index) => editable.has(productIds[index]) && !selected.has(productIds[index]));
    if (removed.length && nodes(memory, 'segment').length) {
      const parser = new XMLParser({ parseTagValue: false });
      const builder = new XMLBuilder(options);
      const segmentIds = (productNode) => {
        const product = parser.parse(builder.build([productNode])).itemProduct?.product;
        if (!product || typeof product !== 'object') {
          throw new Error('Cannot determine product memory; edit this draft in EMS.');
        }
        const segments = product.memorySegment === undefined ? [] :
          Array.isArray(product.memorySegment) ? product.memorySegment : [product.memorySegment];
        if (segments.some((segment) => !segment || !/^[1-9]\d*$/.test(String(segment.id)))) {
          throw new Error('Cannot determine product memory; edit this draft in EMS.');
        }
        return segments.map((segment) => String(segment.id));
      };
      const removedIds = new Set(removed.flatMap(segmentIds));
      const retainedIds = new Set(originalProducts.filter((node) => !removed.includes(node)).flatMap(segmentIds));
      for (const segment of nodes(memory, 'segment')) {
        const segmentId = Array.isArray(segment.segment) && textOf(segment.segment, 'prdMemorySegmentId');
        if (removedIds.has(segmentId) && !retainedIds.has(segmentId)) memory.splice(memory.indexOf(segment), 1);
      }
    }
    const changedMemory = new Set(entitlement.changedMemorySegmentIds.map(String));
    for (const segment of entitlement.memorySegments.filter((entry) => changedMemory.has(String(entry.id)))) {
      const matching = nodes(memory, 'segment').filter((node) =>
        Array.isArray(node.segment) && textOf(node.segment, 'prdMemorySegmentId') === String(segment.id));
      if (matching.length > 1) throw new Error('EMS returned ambiguous entitlement memory segment IDs.');
      if (matching.length) setText(matching[0].segment, 'data', segment.content);
      else memory.push({ segment: [
        { lineItemMemorySegmentID: [] },
        { prdMemorySegmentId: [{ '#text': String(segment.id) }] },
        { prdSuiteLineItemId: [] },
        { data: [{ '#text': segment.content }] },
      ] });
    }
    if (!memoryNodes.length && memory.length) itemFields.push({ memorySegments: memory });
    const entitlementXml = new XMLBuilder(options).build(document);
    const response = await this._fetch(`${this.apiRoot}/entitlement/${id}.ws`, {
      method: 'POST',
      headers: { Accept: 'application/xml, application/json', 'Content-Type': 'application/xml' },
      body: entitlementXml,
    });
    const text = await response.text();
    if (response.status === 401 || response.status === 302) {
      const error = new Error('EMS session expired while updating the entitlement. Please retry.');
      error.status = 401;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`EMS entitlement update failed: ${response.status} ${response.statusText}`);
      error.status = response.status;
      error.body = text;
      throw error;
    }
    return { saved: true, entId: String(id), Eid: entitlement.eid };
  }

  /** Delete an entitlement by its numeric EMS ID, not its EID GUID. */
  async deleteEntitlement(id) {
    if (!this.authenticated) throw new Error('Call authenticate() first.');
    if (!/^[1-9]\d*$/.test(String(id))) throw new Error('Entitlement id must be a positive number.');
    const response = await this._fetch(`${this.apiRoot}/entitlement/${id}.ws`, {
      method: 'DELETE',
      headers: { Accept: 'application/xml, application/json' },
    });
    const text = await response.text();
    if (response.status === 401 || response.status === 302) {
      const error = new Error('EMS session expired while deleting the entitlement. Please retry.');
      error.status = 401;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`EMS entitlement delete failed: ${response.status} ${response.statusText}`);
      error.status = response.status;
      error.body = text;
      throw error;
    }
    return { deleted: true, entId: String(id) };
  }

  /** Save a draft through the EMS web endpoint using the authenticated session. */
  async createEntitlement(entitlement) {
    if (!this.authenticated) throw new Error('Call authenticate() first.');
    const { entitlementXml, lineItemType } = this.buildEntitlementXml(entitlement);
    const webUrl = new URL(`${this.baseUrl}/ems/addEntitlement.html`);
    const sessionUrl = new URL(this.webSessionUrl);
    if (sessionUrl.searchParams.has('ET')) {
      webUrl.searchParams.set('ET', sessionUrl.searchParams.get('ET'));
    }

    const response = await this._fetch(webUrl.href, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Origin: new URL(this.baseUrl).origin,
        Referer: `${this.baseUrl}/ems/entitlementMain.html`,
      },
      body: new URLSearchParams({
        entitlementXML: entitlementXml,
        entProductDynamicMemoryDataXml: '<dynamicMemorySegments></dynamicMemorySegments>',
        produceAndPush: 'false',
        lineItemTypeForProdPush: lineItemType,
        vendorIdForProdPush: entitlement.vendorId,
      }),
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (response.status === 401 || response.status === 302) {
      const error = new Error('EMS session expired while creating the entitlement. Please retry.');
      error.status = 401;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`EMS entitlement creation failed: ${response.status} ${response.statusText}`);
      error.status = response.status;
      error.body = data || text;
      throw error;
    }
    if (!data || !['true', true].includes(data.saved)) {
      const error = new Error(data?.message || 'EMS did not confirm that the entitlement was saved');
      error.status = 502;
      throw error;
    }
    return data;
  }

  /** Fetch the raw entitlement XML using its numeric EMS ID, not its EID GUID. */
  getEntitlement(id) {
    if (!/^\d+$/.test(String(id))) throw new Error('Entitlement id must be the numeric id, e.g. 5057');
    return this.call(`/entitlement/${id}.xml`);
  }

  /** Call an EMS path, resolving non-/ems paths relative to the versioned service root. */
  async call(path, { method = 'GET', body, headers = {} } = {}) {
    if (!this.authenticated) throw new Error('Call authenticate() first.');
    const url = path.startsWith('/ems/') ? `${this.baseUrl}${path}` : `${this.apiRoot}${path}`;
    const res = await this._fetch(url, {
      method,
      headers: {
        Accept: 'application/xml, application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = text;
    try { data = text ? JSON.parse(text) : null; } catch { /* leave as text */ }
    if (!res.ok) {
      const err = new Error(`EMS ${method} ${path} failed: ${res.status} ${res.statusText}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }
}

module.exports = { EmsClient };
