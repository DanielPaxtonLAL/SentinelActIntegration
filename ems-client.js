// Sentinel EMS client (Node 18+, no dependencies).
// Authenticates through the EMS web login (form POST to verifyLogin.html),
// keeps the JSESSIONID cookie, and reuses it for later API calls.

const { XMLParser } = require('fast-xml-parser');

const escapeXml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

class EmsClient {
  constructor({ baseUrl, username, password, apiVersion = 'v90', userType = 'ISV', insecure = false }) {
    if (!baseUrl) throw new Error('baseUrl is required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiVersion = apiVersion;
    this.apiRoot = `${this.baseUrl}/ems/${apiVersion}/ws`;
    this.username = username;
    this.password = password;
    this.userType = userType; // 'ISV' for the vendor login, 'CUSTOMER' for the customer portal
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
    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(xml);
    const inst = parsed?.listResponse?.instance ?? [];
    return Array.isArray(inst) ? inst : [inst];
  }

  async listEnforcements(vendorId = '2') {
    const xml = await this.call(`/enforcement.xml?vendorId=${encodeURIComponent(vendorId)}`);
    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(xml);
    const inst = parsed?.listResponse?.instance ?? [];
    return Array.isArray(inst) ? inst : (inst ? [inst] : []);
  }

  async getEntitlementDetails(id) {
    const xml = await this.getEntitlement(id);
    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(xml);
    const entitlement = parsed?.entitlement;
    if (!entitlement || typeof entitlement !== 'object') {
      throw new Error('EMS returned an invalid entitlement detail');
    }

    const customers = await this.listCustomers();
    const customer = customers.find((entry) =>
      String(entry.customerId ?? entry.id ?? '') === String(entitlement.customerId ?? '')
    );
    const items = entitlement.entitlementItem ?? [];
    const entitlementItems = Array.isArray(items) ? items : [items];
    const products = entitlementItems.flatMap((item) => {
      const itemProducts = item?.itemProduct ?? [];
      const productList = Array.isArray(itemProducts) ? itemProducts : [itemProducts];
      return productList.filter((product) => product && typeof product === 'object').map((product) => ({
        lineItemType: item.lineItemType,
        productId: product.productId,
        productName: product.product?.productName ?? product.productName,
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

  async createEntitlement(entitlement) {
    if (!this.authenticated) throw new Error('Call authenticate() first.');
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
      '<enabled>true</enabled><action>Save</action><isTest>false</isTest>' +
      item('customerId', entitlement.customerId) +
      '<customerEmail></customerEmail><partnerId></partnerId><partnerEmail></partnerEmail>' +
      item('refId1', entitlement.refId1) +
      item('refId2', entitlement.refId2) +
      item('description', entitlement.description) +
      '<proContId></proContId>' +
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
      '</entitlementItem>' +
      '</entitlement>';
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
