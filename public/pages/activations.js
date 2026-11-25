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
    displayValue(value) {
      return value === null || value === undefined || value === '' ? '—' : String(value);
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
