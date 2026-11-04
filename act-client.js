// Minimal Act! Web API client (mirrors auth_test.py).
class ActClient {
  constructor({ baseUrl, database }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.database = database;
    this.token = null;
  }

  // The password is only used for this request; just the token is kept.
  async authenticate(username, password) {
    const basic = Buffer.from(`${username}:${password}`).toString('base64');
    const res = await fetch(`${this.baseUrl}/authorize`, {
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
    // Act! returns the bearer token as plain text.
    this.token = (await res.text()).trim().replace(/^"|"$/g, '');
    if (!this.token) throw new Error('Act! returned an empty token');
  }

  async listCompanies() {
    const pageSize = 200;
    const all = [];
    // Page through results until a short page signals the end.
    for (let skip = 0; ; skip += pageSize) {
    const res = await fetch(`${this.baseUrl}/api/companies?$top=${pageSize}&$skip=${skip}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
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
}

module.exports = { ActClient };
