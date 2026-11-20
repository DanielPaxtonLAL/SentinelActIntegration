const { createApp } = Vue;

createApp({
  data() {
    return {
      entityName: '',
      result: null,
      loading: false,
      error: '',
    };
  },
  computed: {
    status() {
      if (this.loading) return 'Loading custom entities…';
      if (this.error) return this.error;
      if (this.result === null) return 'Enter an entity name or leave it blank to list all custom entities.';
      return this.isArrayResult
        ? `${this.rows.length} custom entities`
        : 'Custom entity response loaded.';
    },
    rows() {
      if (Array.isArray(this.result)) return this.result;
      if (this.result && typeof this.result === 'object') {
        for (const key of ['value', 'items', 'entities']) {
          if (Array.isArray(this.result[key])) return this.result[key];
        }
      }
      return [];
    },
    columns() {
      return [...new Set(this.rows.flatMap((row) =>
        row && typeof row === 'object' && !Array.isArray(row) ? Object.keys(row) : ['value']
      ))];
    },
    isArrayResult() {
      return Array.isArray(this.result) ||
        Boolean(this.result && ['value', 'items', 'entities'].some((key) => Array.isArray(this.result[key])));
    },
    formattedResult() {
      return JSON.stringify(this.result, null, 2);
    },
  },
  methods: {
    formatValue(value) {
      return value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
    },
    cellValue(row, key) {
      return key === 'value' && (row === null || typeof row !== 'object') ? row : row[key];
    },
    async loadEntities() {
      this.loading = true;
      this.error = '';
      try {
        const name = this.entityName ? `/${encodeURIComponent(this.entityName)}` : '';
        const response = await fetch(`/api/act/custom-entities${name}`);
        const data = await response.json();
        if (response.status === 401) {
          window.location.replace('/login.html');
          return;
        }
        if (!response.ok) throw new Error(data.error || response.statusText);
        this.result = data;
      } catch (err) {
        this.error = 'Failed to load custom entities: ' + err.message;
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
    async checkSession() {
      try {
        const response = await fetch('/api/session');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        if (!data.authenticated) {
          window.location.replace('/login.html');
          return;
        }
        await this.loadEntities();
      } catch (err) {
        this.error = 'Failed to restore EMS session: ' + err.message;
      }
    },
  },
  mounted() {
    this.checkSession();
  },
}).mount('#app');
