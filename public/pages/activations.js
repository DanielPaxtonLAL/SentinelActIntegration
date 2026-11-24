const { createApp } = Vue;

createApp({
  data() {
    return { activations: [], filter: '', loading: false, error: '' };
  },
  computed: {
    status() {
      if (this.loading) return 'Loading activations…';
      if (this.error) return this.error;
      return `${this.activations.length} records`;
    },
    filteredActivations() {
      const query = this.filter.toLocaleLowerCase();
      if (!query) return this.activations;
      return this.activations.filter((activation) =>
        [activation.customerName, activation.productKeyId, activation.aid, activation.protectionKeyId]
          .some((value) => String(value ?? '').toLocaleLowerCase().includes(query))
      );
    },
  },
  methods: {
    licenseDownloadUrl(license) {
      return 'data:application/xml;charset=utf-8,' + encodeURIComponent(license);
    },
    displayValue(value) {
      return value === null || value === undefined || value === '' ? '—' : String(value);
    },
    async fetchPendingUpdates(activation) {
      if (!activation.aid || activation.pendingUpdate?.loading) return;
      activation.pendingUpdate = { loading: true, error: '', package: '' };
      const state = activation.pendingUpdate;
      try {
        const response = await fetch(`/api/activations/${encodeURIComponent(activation.aid)}/pending-updates`, {
          method: 'POST',
          cache: 'no-store',
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        if (typeof data.package !== 'string' || !data.package.trim()) throw new Error('The server returned an invalid V2CP package.');
        state.package = data.package;
      } catch (err) {
        state.error = 'Failed to fetch pending updates: ' + err.message;
      } finally {
        state.loading = false;
      }
    },
    async loadActivations() {
      this.loading = true;
      this.error = '';
      try {
        const response = await fetch('/api/activations', { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        if (!Array.isArray(data.activations)) throw new Error('The server returned an invalid activations list');
        this.activations = data.activations;
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
