// Sentinel EMS client (Node 18+, no dependencies).
// Authenticates through the EMS web login (form POST to verifyLogin.html),
// keeps the JSESSIONID cookie, and reuses it for later API calls.

const { XMLParser, XMLBuilder, XMLValidator } = require('fast-xml-parser');

const escapeXml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

class EmsClient {
  constructor({ baseUrl, username, password, apiVersion = 'v90', userType = 'ISV', insecure = false, serialNumberCustomerId }) {
    if (!baseUrl) throw new Error('baseUrl is required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiVersion = apiVersion;
    this.apiRoot = `${this.baseUrl}/ems/${apiVersion}/ws`;
    this.username = username;
    this.password = password;
    this.userType = userType; // 'ISV' for the vendor login, 'CUSTOMER' for the customer portal
    this.serialNumberCustomerId = serialNumberCustomerId;
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

  // Logs in via the EMS login form and establishes the session.
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

  // Lists customers as an array of plain objects.
  async listCustomers() {
    const xml = await this.call('/customer.xml');
    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(xml);
    const inst = parsed?.listResponse?.instance ?? [];
    return Array.isArray(inst) ? inst : [inst];
  }

  async _serialNumberCustomer() {
    const id = this.serialNumberCustomerId;
    if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id)) {
      throw new Error('Configure a valid highest-product-key-serial-number-customer-id before accessing the serial number.');
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

  async getLargestProductKeySerial() {
    const { reference } = await this._serialNumberCustomer();
    const value = reference.refId.map((node) => node['#text']).join('').trim();
    if (!/^\d+$/.test(value) || BigInt(value) > 65535n) {
      throw new Error('The serial number customer has an invalid Ref ID 1; expected a number from 0 to 65,535.');
    }
    return Number(value);
  }

  async setLargestProductKeySerial(newSerialNumber) {
    const value = String(newSerialNumber);
    if (!/^\d+$/.test(value) || BigInt(value) > 65535n) {
      throw new Error('Serial number must be a whole number from 0 to 65,535.');
    }
    const { document, reference, options } = await this._serialNumberCustomer();
    reference.refId = [{ '#text': String(Number(value)) }];
    const response = await this._fetch(`${this.apiRoot}/customer/${this.serialNumberCustomerId}.ws`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/xml', Accept: 'application/xml' },
      body: new XMLBuilder(options).build(document),
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

  // Creates a customer via PUT /customer.ws with an XML body; returns the Location header.
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

  // Lists entitlements (XML). The server returns XML even for .json requests.
  async listEntitlements() {
    const xml = await this.call('/entitlement.xml');
    const parsed = new XMLParser({
      ignoreAttributes: false, attributeNamePrefix: '',
      tagValueProcessor: (name, value) => name === 'refId1' ? null : value,
    }).parse(xml);
    const inst = parsed?.listResponse?.instance ?? [];
    return Array.isArray(inst) ? inst : [inst];
  }

  async listEnforcements(vendorId = '2') {
    const xml = await this.call(`/enforcement.xml?vendorId=${encodeURIComponent(vendorId)}`);
    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(xml);
    const inst = parsed?.listResponse?.instance ?? [];
    return Array.isArray(inst) ? inst : (inst ? [inst] : []);
  }

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

  async findBaseProductByIdentifier(identifier, vendorId = '2') {
    const products = await this.listProductsByIdentifier(identifier, vendorId);
    const bases = products.filter((entry) => entry.type.toUpperCase() === 'BASE');
    if (bases.length !== 1) throw new Error(`Expected one base product with identifier ${identifier} in EMS; found ${bases.length}`);
    return bases[0];
  }

  // Reads one product by its internal EMS id.
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

  async getEntitlementDetails(id) {
    const xml = await this.getEntitlement(id);
    const parsed = new XMLParser({
      ignoreAttributes: false, attributeNamePrefix: '',
      tagValueProcessor: (name, value) => name === 'refId1' ? null : value,
    }).parse(xml);
    const entitlement = parsed?.entitlement;
    if (!entitlement || typeof entitlement !== 'object') {
      throw new Error('EMS returned an invalid entitlement detail');
    }

    const customers = await this.listCustomers();
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
              saot: String(segment.saot) === 'true',
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
      products,
    };
  }

  async listCatalog(category, vendorId = '2') {
    if (!this.authenticated) throw new Error('Call authenticate() first.');

    const catalogRoutes = {
      products: {
        path: 'baseProductListing.html',
        params: {
          productName: '',
          namespace: '',
          versionValue: '',
          refId1: '',
          refId2: '',
          enforcementId: '',
          sortCol: 'productId',
        },
      },
      features: {
        path: 'featureList.html',
        params: {
          featureName: '',
          namespace: '',
          refId1: '',
          refId2: '',
          sortCol: 'id',
        },
      },
      dynamicMemory: {
        path: 'dynamicMemoryList.html',
        params: {
          memoryName: '',
          memoryType: '-1',
          memoryFileId: '-1',
          memoryRefId1: '',
          sortCol: 'id',
        },
      },
    };
    const route = catalogRoutes[category];
    if (!route) throw new Error(`Unsupported EMS catalog category: ${category}`);

    const url = new URL(`${this.baseUrl}/ems/${route.path}`);
    for (const [name, value] of Object.entries({
      returnFormat: 'json',
      ...route.params,
      vendorId: String(vendorId),
      pageIndex: '1',
      pageSize: '100',
      sortOrder: 'asc',
    })) {
      url.searchParams.set(name, value);
    }
    const sessionUrl = new URL(this.webSessionUrl);
    if (sessionUrl.searchParams.has('ET')) {
      url.searchParams.set('ET', sessionUrl.searchParams.get('ET'));
    }

    const response = await this._fetch(url.href, { headers: { Accept: 'application/json' } });
    const text = await response.text();
    if (response.status === 401 || response.status === 302) {
      const error = new Error('EMS session expired while loading the catalog. Please retry.');
      error.status = 401;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`EMS ${category} catalog failed: ${response.status} ${response.statusText}`);
      error.status = response.status;
      error.body = text;
      throw error;
    }

    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      const error = new Error(`EMS returned invalid ${category} catalog data`);
      error.status = 502;
      throw error;
    }
    if (!data || !Array.isArray(data.items)) {
      const error = new Error(`EMS returned an invalid ${category} catalog list`);
      error.status = 502;
      throw error;
    }
    return data.items;
  }

  buildEntitlementXml(entitlement) {
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

  // Saves changes to an existing entitlement; returns the same shape as createEntitlement.
  async updateEntitlement(id, entitlement) {
    if (!this.authenticated) throw new Error('Call authenticate() first.');
    if (!/^[1-9]\d*$/.test(String(id)) || !entitlement.eid) throw new Error('Entitlement id and eid are required.');
    const { entitlementXml } = this.buildEntitlementXml(entitlement);
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

  // Deletes an entitlement by its numeric id (not the EID GUID).
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

  // Gets one entitlement by its numeric id (e.g. 5057), not the EID GUID.
  getEntitlement(id) {
    if (!/^\d+$/.test(String(id))) throw new Error('Entitlement id must be the numeric id, e.g. 5057');
    return this.call(`/entitlement/${id}.xml`);
  }

  // A path starting with /ems/ is used as-is; otherwise it is relative to /ems/<version>/ws.
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
