/** Read-only Act! Web API client. Each authenticated browser session owns its client. */
class ActClient {
  /**
   * @param {{baseUrl: string, database: string}} options Act! Web API connection settings.
   */
  constructor({ baseUrl, database }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.database = database;
    this.token = null;
  }

  /** Restrict requests to the configured API origin and path before sending credentials. */
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

  /** Exchange credentials for a bearer token; the password is not retained. */
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

  /** Fetch all company pages until the API returns a partial page. */
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

  /** Fetch a single company by its Act! identifier. */
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

  /** Fetch the divisions belonging to a company. */
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
