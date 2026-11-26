const { createApp } = Vue;

createApp({
  data() {
    return {
      activations: [], keys: [], selectedKey: null, filter: '', loading: false, error: '',
      updates: [], updatesLoading: false, updatesError: '', selectionRequest: 0,
    };
  },
  computed: {
    status() {
      if (this.loading) return 'Loading activations…';
      if (this.error) return this.error;
      return `${this.keys.length} keys`;
    },
    filteredKeys() {
      const query = this.filter.toLocaleLowerCase();
      if (!query) return this.keys;
      return this.keys.filter((key) =>
        [key.protectionKeyId, ...key.customerNames, ...key.productKeyIds, ...key.activationIds]
          .some((value) => value.toLocaleLowerCase().includes(query))
      );
    },
    sortedUpdates() {
      return [...this.updates].sort((a, b) => {
        const first = this.updateTimestamp(a.createDate);
        const second = this.updateTimestamp(b.createDate);
        if (first === null) return second === null ? 0 : 1;
        if (second === null) return -1;
        return second - first;
      });
    },
  },
  methods: {
    displayValue(value) {
      return value === null || value === undefined || value === '' ? '—' : String(value);
    },
    updateTimestamp(value) {
      if (typeof value !== 'string') return null;
      const text = value.trim();
      const match = /^(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i.exec(text);
      if (!match) return null;
      const date = Date.parse(match[1]);
      if (Number.isNaN(date) || new Date(date).toISOString().slice(0, 10) !== match[1]) return null;
      const timestamp = Date.parse(text.includes(' ') ? text.replace(' ', 'T') : text);
      return Number.isNaN(timestamp) ? null : timestamp;
    },
    updateCreatedDate(value) {
      const timestamp = this.updateTimestamp(value);
      if (timestamp === null) return 'Unavailable';
      const iso = new Date(timestamp).toISOString();
      const date = `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
      return /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? date : `${date} ${iso.slice(11, 19)}`;
    },
    groupKeys(activations) {
      const groups = new Map();
      for (const activation of activations) {
        const protectionKeyId = String(activation.protectionKeyId ?? '').trim();
        const productKeyId = String(activation.productKeyId ?? '').trim();
        const groupId = protectionKeyId ? `protection:${protectionKeyId}` : `product:${productKeyId}`;
        if (!groups.has(groupId)) {
          groups.set(groupId, {
            groupId, protectionKeyId, customerNames: [], productKeyIds: [], activationIds: [],
          });
        }
        const key = groups.get(groupId);
        for (const [field, value] of [
          ['customerNames', activation.customerName], ['productKeyIds', productKeyId], ['activationIds', activation.aid],
        ]) {
          const text = String(value ?? '').trim();
          if (text && !key[field].includes(text)) key[field].push(text);
        }
      }
      return [...groups.values()];
    },
    async selectKey(key) {
      const request = ++this.selectionRequest;
      this.selectedKey = key;
      this.updates = [];
      this.updatesError = '';
      this.updatesLoading = false;
      if (!key.protectionKeyId) return;
      this.updatesLoading = true;
      try {
        const response = await fetch(`/api/protection-keys/${encodeURIComponent(key.protectionKeyId)}/entitlements`, { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        if (!Array.isArray(data) || data.some((update) =>
          !update || !/^[1-9]\d*$/.test(String(update.id)) || String(update.type) !== '3'
        )) throw new Error('The server returned invalid key updates.');
        if (request === this.selectionRequest) this.updates = data;
      } catch (err) {
        if (request === this.selectionRequest) this.updatesError = 'Failed to load key updates: ' + err.message;
      } finally {
        if (request === this.selectionRequest) this.updatesLoading = false;
      }
    },
    async fetchHistoryPackage(activation) {
      if (!activation.protectionKeyId || activation.historyPackage?.loading) return;
      activation.historyPackage = { loading: true, error: '' };
      const state = activation.historyPackage;
      try {
        const packageXml = await V2cpDownload.fetchPackage(activation.protectionKeyId);
        V2cpDownload.downloadPackage(activation.protectionKeyId, packageXml);
      } catch (err) {
        state.error = 'Failed to build V2CP: ' + err.message;
      } finally {
        state.loading = false;
      }
    },
    async loadActivations() {
      this.loading = true;
      this.error = '';
      const selectedId = this.selectedKey?.groupId;
      this.selectionRequest++;
      this.selectedKey = null;
      this.updates = [];
      this.updatesLoading = false;
      this.updatesError = '';
      try {
        const response = await fetch('/api/activations', { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        if (!Array.isArray(data.activations)) throw new Error('The server returned an invalid activations list');
        if (data.activations.some((activation) => !activation || typeof activation.productKeyId !== 'string' || !activation.productKeyId.trim())) {
          throw new Error('The server returned an activation without a product key ID');
        }
        this.activations = data.activations;
        this.keys = this.groupKeys(data.activations);
        const selected = this.keys.find((key) => key.groupId === selectedId) || this.keys[0];
        this.loading = false;
        if (selected) this.selectKey(selected);
        else {
          this.selectionRequest++;
          this.selectedKey = null;
          this.updates = [];
          this.updatesLoading = false;
          this.updatesError = '';
        }
      } catch (err) {
        this.error = 'Failed to load activations: ' + err.message;
      } finally {
        this.loading = false;
      }
    },
    async logout() {
      this.loading = true;
      this.error = '';
      try {
        const response = await fetch('/api/logout', { method: 'POST' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        window.location.replace('/login.html');
      } catch (err) {
        this.error = 'Log out failed: ' + err.message;
        this.loading = false;
      }
    },
  },
  mounted() {
    this.loadActivations();
  },
}).mount('#app');
