const { createApp } = Vue;

const CompanyTreeNode = {
  name: 'CompanyTreeNode',
  props: {
    node: { type: Object, required: true },
    selectedCompany: { type: Object, default: null },
  },
  emits: ['select'],
  data() {
    return { expanded: false };
  },
  computed: {
    canExpand() {
      return this.node.children.length > 0 || Boolean(this.node.company && this.node.company.hasDivisions);
    },
  },
  methods: {
    toggle() {
      this.expanded = !this.expanded;
      if (this.node.company) this.$emit('select', this.node.company);
    },
  },
  template: `
        <li class="company-tree-node">
          <div class="company-tree-row">
            <button v-if="canExpand" type="button" class="company-tree-toggle"
              :aria-expanded="expanded" @click="toggle">
              <span aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
              {{ node.label }}
            </button>
            <button v-else-if="node.company" type="button" class="company-tree-toggle"
              :class="{ selected: selectedCompany === node.company }"
            @click="$emit('select', node.company)">
              <span class="company-tree-spacer" aria-hidden="true"></span>
            {{ node.label }}
            </button>
            <span v-else class="company-tree-toggle company-tree-label">
              <span class="company-tree-spacer" aria-hidden="true"></span>
              {{ node.label }}
            </span>
          </div>
          <ul v-if="expanded && node.children.length" class="company-tree">
            <company-tree-node v-for="child in node.children" :key="child.key"
              :node="child" :selected-company="selectedCompany" @select="$emit('select', $event)" />
          </ul>
          <div v-if="expanded && canExpand && !node.children.length" class="company-tree-status">No divisions</div>
        </li>
      `,
};

createApp({
  components: { CompanyTreeNode },
  data() {
    return {
      customers: [],
      companies: [],
      companySync: {},
      divisionParents: {},
      divisionIndexError: '',
      divisionIndexRequestId: 0,
      selectedCompany: null,
      actLoading: false,
      actAuthenticated: false,
      actError: '',
      companyFilter: '',
    };
  },
  computed: {
    actStatus() {
      if (this.actLoading) return 'Loading…';
      if (this.actError) return this.actError;
      return this.actAuthenticated ? `${this.companies.length} companies` : 'Log in to load companies';
    },
    filteredCompanies() {
      const query = this.companyFilter.trim().toLowerCase();
      return this.companies
        .filter((company) =>
          !query || this.companyDisplayName(company).toLowerCase().includes(query)
        )
        .sort((a, b) => this.companyDisplayName(a).localeCompare(this.companyDisplayName(b), undefined, {
          sensitivity: 'base',
          numeric: true,
        }));
    },
    companyTree() {
      const roots = [];
      const nodes = new Map(this.companies.map((company) => [
        String(company.id),
        {
          key: String(company.id),
          label: this.companyDisplayName(company),
          company,
          children: [],
        },
      ]));

      for (const company of this.companies) {
        const node = nodes.get(String(company.id));
        const parent = nodes.get(this.divisionParents[String(company.id)]);
        if (parent && parent !== node) parent.children.push(node);
        else roots.push(node);
      }

      const sortNodes = (items) => {
        items.sort((a, b) => a.label.localeCompare(b.label, undefined, {
          sensitivity: 'base',
          numeric: true,
        }));
        items.forEach((node) => sortNodes(node.children));
      };
      sortNodes(roots);
      const query = this.companyFilter.trim().toLowerCase();
      const filterNode = (node) => {
        const matches = !query || node.label.toLowerCase().includes(query);
        if (matches) return node;
        const children = node.children.map(filterNode).filter(Boolean);
        return children.length ? { ...node, children } : null;
      };
      return roots.map(filterNode).filter(Boolean);
    },
  },
  methods: {
    companyDisplayName(company) {
      return typeof company.hierarchy === 'string' && company.hierarchy.trim()
        ? company.hierarchy
        : String(company.name || 'Unnamed company');
    },
    inEms(company) {
      const id = String(company.id ?? '').trim().toLowerCase();
      return Boolean(id) && this.customers.some((c) => String(c.refId1 ?? '').trim().toLowerCase() === id);
    },
    selectCompany(company) {
      this.selectedCompany = company;
    },
    async loadDivisionIndex(companies) {
      const requestId = ++this.divisionIndexRequestId;
      const parents = companies.filter((company) => company.id && company.hasDivisions);
      const parentMap = {};
      const failedParents = [];
      let nextIndex = 0;
      const worker = async () => {
        while (nextIndex < parents.length) {
          const parent = parents[nextIndex++];
          try {
            const response = await fetch(`/api/act/companies/${encodeURIComponent(parent.id)}/divisions`);
            const data = await response.json();
            if (response.status === 401) {
              this.actAuthenticated = false;
              window.location.replace('/login.html');
              return;
            }
            if (!response.ok) throw new Error(data.error || response.statusText);
            if (!Array.isArray(data)) throw new Error('Act! returned an invalid divisions response');
            for (const division of data) {
              if (division && division.id) {
                parentMap[String(division.id)] = String(division.parentID || parent.id);
              }
            }
          } catch (err) {
            failedParents.push(parent.name || parent.id);
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(4, parents.length) }, worker));
      if (requestId !== this.divisionIndexRequestId) return;
      this.divisionParents = parentMap;
      this.divisionIndexError = failedParents.length
        ? `Could not load divisions for: ${failedParents.join(', ')}`
        : '';
    },
    async restoreActSession() {
      this.actLoading = true;
      this.actError = '';
      try {
        const response = await fetch('/api/session');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        this.actAuthenticated = data.authenticated;
        if (!this.actAuthenticated) {
          window.location.replace('/login.html');
          return;
        }
        await Promise.all([this.loadCustomers(), this.loadCompanies()]);
      } catch (err) {
        this.actError = 'Failed to restore EMS session: ' + err.message;
      } finally {
        this.actLoading = false;
      }
    },
    async loadCompanies() {
      this.actLoading = true;
      this.actError = '';
      try {
        const response = await fetch('/api/act/companies');
        const data = await response.json();
        if (response.status === 401) {
          this.actAuthenticated = false;
          window.location.replace('/login.html');
          return;
        }
        if (!response.ok) throw new Error(data.error || response.statusText);
        this.companies = data;
        await this.loadDivisionIndex(data);
        if (!this.selectedCompany || !data.some((company) => company.id === this.selectedCompany.id)) {
          this.selectedCompany = data[0] || null;
        }
        this.actAuthenticated = true;
      } catch (err) {
        this.actError = 'Failed to load companies: ' + err.message;
      } finally {
        this.actLoading = false;
      }
    },
    async logout() {
      this.actLoading = true;
      this.actError = '';
      try {
        const response = await fetch('/api/logout', { method: 'POST' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        window.location.replace('/login.html');
      } catch (err) {
        this.actError = 'Log out failed: ' + err.message;
        this.actLoading = false;
      }
    },
    async addCompanyToEms(company) {
      const id = company.id;
      if (!id) return;
      this.companySync[id] = { state: 'adding', error: '' };
      try {
        const response = await fetch(`/api/act/companies/${encodeURIComponent(id)}/add-to-ems`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parentId: this.divisionParents[String(id)] || null }),
        });
        const data = await response.json();
        if (response.status === 401) {
          this.actAuthenticated = false;
          window.location.replace('/login.html');
          return;
        }
        if (!response.ok) throw new Error(data.error || response.statusText);
        this.companySync[id] = { state: 'added', error: '' };
        await this.loadCustomers();
      } catch (err) {
        this.companySync[id] = { state: 'error', error: 'Failed: ' + err.message };
        if (/already exists/.test(err.message)) await this.loadCustomers();
      }
    },
    async loadCustomers() {
      try {
        const response = await fetch('/api/customers');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        this.customers = data;
      } catch (err) {
        this.actError = 'Failed to load EMS customer references: ' + err.message;
      }
    },
  },
  mounted() {
    this.restoreActSession();
  },
}).mount('#app');

const reloadEvents = new EventSource('/__dev/reload');
reloadEvents.addEventListener('reload', () => window.location.reload());
