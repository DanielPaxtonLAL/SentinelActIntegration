// Sentinel EMS client (Node 18+, no dependencies).
// Authenticates through the EMS web login (form POST to verifyLogin.html),
// keeps the JSESSIONID cookie, and reuses it for later API calls.

const { XMLParser } = require('fast-xml-parser');

class EmsClient {
  constructor({ baseUrl, username, password, apiVersion = 'v90', userType = 'ISV', insecure = false }) {
    if (!baseUrl) throw new Error('baseUrl is required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
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
    return { baseUrl: this.baseUrl, sessionId: this.cookies.get('JSESSIONID'), redirectedTo: location };
  }

  // Lists customers as an array of plain objects.
  async listCustomers() {
    const xml = await this.call('/customer.xml');
    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(xml);
    const inst = parsed?.listResponse?.instance ?? [];
    return Array.isArray(inst) ? inst : [inst];
  }

  // Lists entitlements (XML). The server returns XML even for .json requests.
  listEntitlements() {
    return this.call('/entitlement.xml');
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
