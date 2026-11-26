const { createApp } = Vue;

createApp({
  data() {
    return {
      activations: [], keys: [], selectedKey: null, filter: '', loading: false, error: '',
      updates: [], originalEntitlement: null, originalError: '', updatesLoading: false, updatesError: '', counterWarning: '', selectionRequest: 0,
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
        const firstCounter = typeof a.updateCounter === 'string' && /^\d+$/.test(a.updateCounter) ? BigInt(a.updateCounter) : null;
        const secondCounter = typeof b.updateCounter === 'string' && /^\d+$/.test(b.updateCounter) ? BigInt(b.updateCounter) : null;
        if (firstCounter !== null && secondCounter === null) return -1;
        if (firstCounter === null && secondCounter !== null) return 1;
        if (firstCounter !== null && secondCounter !== null && firstCounter !== secondCounter) {
          return firstCounter > secondCounter ? -1 : 1;
        }
        const first = this.updateTimestamp(a.createDate);
        const second = this.updateTimestamp(b.createDate);
        if (first === null) return second === null ? 0 : 1;
        if (second === null) return -1;
        return second - first;
      });
    },
    timelineEntries() {
      return this.originalEntitlement ? [...this.sortedUpdates, this.originalEntitlement] : this.sortedUpdates;
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
      this.originalEntitlement = null;
      this.originalError = '';
      this.updatesError = '';
      this.counterWarning = '';
      this.updatesLoading = false;
      if (!key.protectionKeyId) return;
      this.updatesLoading = true;
      try {
        const response = await fetch(`/api/protection-keys/${encodeURIComponent(key.protectionKeyId)}/entitlements?includeOriginal=1`, { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        const validEntry = (entry, type) => entry && /^[1-9]\d*$/.test(String(entry.id)) &&
          entry.type === type && Array.isArray(entry.products) &&
          entry.products.every((product) => product && typeof product === 'object');
        if (!data || !Array.isArray(data.updates) || data.updates.some((update) => !validEntry(update, 3)) ||
            typeof data.originalError !== 'string' ||
            (data.original === null ? !data.originalError : !validEntry(data.original, 2) || !!data.originalError)) {
          throw new Error('The server returned invalid key timeline data.');
        }
        if (request !== this.selectionRequest) return;
        this.originalEntitlement = data.original;
        this.originalError = data.originalError;
        this.updates = data.updates;
        if (data.updates.length) {
          try {
            const counterResponse = await fetch(`/api/protection-keys/${encodeURIComponent(key.protectionKeyId)}/update-counters`, { cache: 'no-store' });
            const history = await counterResponse.json();
            if (!counterResponse.ok) throw new Error(history.error || counterResponse.statusText);
            if (!Array.isArray(history.activations) || !Array.isArray(history.warnings) ||
                history.activations.some((item) => !item || typeof item.aid !== 'string' || !item.aid ||
                  !/^[1-9]\d*$/.test(String(item.entitlementId)))) {
              throw new Error('The server returned invalid counter history.');
            }
            if (request !== this.selectionRequest) return;
            if (history.warnings.length) {
              this.counterWarning = 'Counter history is incomplete; updates are ordered by creation date. ' + history.warnings.join(' ');
            } else {
              this.updates = data.updates.map((update) => {
                const matches = history.activations.filter((item) => String(item.entitlementId) === String(update.id));
                const aids = new Set(matches.map((item) => item.aid));
                const counters = new Set(matches.filter((item) => !item.counterError &&
                  typeof item.updateCounter === 'string' && /^\d+$/.test(item.updateCounter))
                  .map((item) => BigInt(item.updateCounter).toString()));
                const valid = matches.length > 0 && aids.size === 1 && counters.size === 1 &&
                  matches.every((item) => !item.counterError && typeof item.updateCounter === 'string' && /^\d+$/.test(item.updateCounter));
                const failed = matches.find((item) => item.counterError);
                const counterIssue = failed ? 'Counter lookup failed: ' + failed.counterError :
                  matches.length && !valid ? 'Activation counters are missing or ambiguous.' : '';
                return { ...update, updateCounter: valid ? [...counters][0] : null, counterIssue };
              });
            }
          } catch (err) {
            if (request === this.selectionRequest) this.counterWarning = 'Unable to load update counters: ' + err.message;
          }
        }
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
      this.originalEntitlement = null;
      this.originalError = '';
      this.updatesLoading = false;
      this.updatesError = '';
      this.counterWarning = '';
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
