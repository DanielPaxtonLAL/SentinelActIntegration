// Read-only Act! Web API client (mirrors auth_test.py).
class ActClient {
  constructor({ baseUrl, database }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.database = database;
    this.token = null;
  }

  async _get(url, { headers }) {
    const requestUrl = new URL(url);
    const baseUrl = new URL(this.baseUrl);
    const basePath = baseUrl.pathname.replace(/\/+$/, '');
    if (requestUrl.origin !== baseUrl.origin ||
        (requestUrl.pathname !== basePath && !requestUrl.pathname.startsWith(`${basePath}/`))) {
      throw new Error('Act! requests must stay within the configured API URL');
    }

    return fetch(requestUrl.href, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(30000),
    });
  }

  // The password is only used for this request; just the token is kept.
  async authenticate(username, password) {
    const basic = Buffer.from(`${username}:${password}`).toString('base64');
    const res = await this._get(`${this.baseUrl}/authorize`, {
      headers: {
        Authorization: `Basic ${basic}`,
        'Act-Database-Name': this.database,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const err = new Error(`Act! authorize failed: ${res.status} ${res.statusText}\n${await res.text()}`);
      err.status = res.status;
      throw err;
    }
    this.token = (await res.text()).trim().replace(/^"|"$/g, '');
    if (!this.token) throw new Error('Act! returned an empty token');
  }

  async listCompanies() {
    const pageSize = 200;
    const all = [];
    for (let skip = 0; ; skip += pageSize) {
      const res = await this._get(`${this.baseUrl}/api/companies?$top=${pageSize}&$skip=${skip}`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) {
        const err = new Error(`Act! companies failed: ${res.status} ${res.statusText}\n${await res.text()}`);
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      const page = Array.isArray(data) ? data : data.value || data.items || [];
      all.push(...page);
      if (page.length < pageSize) return all;
    }
  }

  async getCompany(companyId) {
    const res = await this._get(`${this.baseUrl}/api/companies/${encodeURIComponent(companyId)}`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const err = new Error(`Act! company ${companyId} failed: ${res.status} ${res.statusText}\n${await res.text()}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async getCompanyDivisions(companyId) {
    const res = await this._get(`${this.baseUrl}/api/companies/${encodeURIComponent(companyId)}/divisions`, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const err = new Error(`Act! company divisions failed: ${res.status} ${res.statusText}\n${await res.text()}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

}

module.exports = { ActClient };
