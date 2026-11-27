const { createApp } = Vue;

function customerText(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

async function fetchKeyTimeline(protectionKeyId) {
  const response = await fetch(`/api/protection-keys/${encodeURIComponent(protectionKeyId)}/entitlements?includeOriginal=1`, { cache: 'no-store' });
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
  return data;
}

async function fetchKeyCounters(protectionKeyId) {
  const response = await fetch(`/api/protection-keys/${encodeURIComponent(protectionKeyId)}/update-counters`, { cache: 'no-store' });
  const history = await response.json();
  if (!response.ok) throw new Error(history.error || response.statusText);
  if (!Array.isArray(history.activations) || !Array.isArray(history.warnings) ||
      history.activations.some((item) => !item || typeof item.aid !== 'string' || !item.aid ||
        !/^[1-9]\d*$/.test(String(item.entitlementId)))) {
    throw new Error('The server returned invalid counter history.');
  }
  return history;
}

async function fetchCustomers() {
  const response = await fetch('/api/customers', { cache: 'no-store' });
  const customers = await response.json();
  if (!response.ok) throw new Error(customers.error || response.statusText);
  if (!Array.isArray(customers)) throw new Error('The server returned an invalid customer list.');
  return customers;
}

function findCustomerName(customers, customerId) {
  const matches = customers.filter((customer) => customer &&
    String(customer.customerId ?? customer.id ?? '').trim() === customerId);
  const name = matches.length === 1 ? customerText(matches[0].name) || customerText(matches[0].customerName) : '';
  if (!name) throw new Error(`Customer ${customerId} was not found or is ambiguous.`);
  return name;
}

function orderedEntitlementHistory(state) {
  if (state.updatesError || state.originalError || !state.originalEntitlement) {
    return { reason: state.updatesError || state.originalError || 'The original entitlement is unavailable.' };
  }
  const history = state.counterHistory;
  if (!history || history.warnings.length) {
    return { reason: state.counterWarning || 'A complete activation counter history is required.' };
  }
  const entries = [state.originalEntitlement, ...state.updates];
  const byId = new Map(entries.map((entry) => [String(entry.id), entry]));
  if (byId.size !== entries.length) return { reason: 'Entitlements are ambiguous.' };
  const byAid = new Map();
  for (const activation of history.activations) {
    if (activation.counterError || typeof activation.updateCounter !== 'string' ||
        !/^\d+$/.test(activation.updateCounter) || !byId.has(String(activation.entitlementId))) {
      return { reason: 'Activation counters or their entitlements are missing or ambiguous.' };
    }
    const record = { entitlementId: String(activation.entitlementId), counter: BigInt(activation.updateCounter) };
    const previous = byAid.get(activation.aid);
    if (previous && (previous.entitlementId !== record.entitlementId || previous.counter !== record.counter)) {
      return { reason: 'Activation history contains conflicting records.' };
    }
    byAid.set(activation.aid, record);
  }
  const ordered = [...byAid.values()].sort((a, b) => a.counter < b.counter ? -1 : a.counter > b.counter ? 1 : 0);
  if (ordered.length !== entries.length || ordered.some((entry, index) => entry.counter !== BigInt(index)) ||
      ordered[0]?.entitlementId !== String(state.originalEntitlement.id) ||
      new Set(ordered.map((entry) => entry.entitlementId)).size !== entries.length) {
    return { reason: 'Activation counters must uniquely cover the original and every update in sequence.' };
  }
  return { entries: ordered.map((entry) => byId.get(entry.entitlementId)), reason: '' };
}

createApp({
  data() {
    return {
      activations: [], keys: [], selectedKey: null, filter: '', loading: false, error: '',
      updates: [], originalEntitlement: null, originalError: '', updatesLoading: false, updatesError: '', counterWarning: '', selectionRequest: 0,
      featureProductIds: null, counterHistory: null, customerLookup: null, memoryConfig: null, versionProductMemory: {}, listRequest: 0,
      associatedEntitlementId: '', associationError: '',
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
      return this.keys.filter((key) =>
        !query || [key.protectionKeyId, key.serialNumber || '', key.currentCustomer?.value || '', ...key.customerNames, ...key.productKeyIds, ...key.activationIds]
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
    expectedCustomer() {
      if (this.updatesLoading) return { value: 'Loading…', reason: '' };
      const history = orderedEntitlementHistory(this);
      if (history.reason) return { value: 'Unavailable', reason: history.reason };
      const latest = history.entries[history.entries.length - 1];
      const name = customerText(latest.customer);
      if (name) return { value: name, reason: '' };
      if (this.customerLookup?.id === String(latest.customerId ?? '').trim()) {
        if (this.customerLookup.error) return { value: 'Unavailable', reason: this.customerLookup.error };
        if (this.customerLookup.name) return { value: this.customerLookup.name, reason: '' };
      }
      return { value: 'Unavailable', reason: 'The latest entitlement customer is unavailable.' };
    },
    expectedMemory() {
      const fields = ['serial', 'expiry', 'version'];
      const all = (value, reason) => Object.fromEntries(fields.map((field) => [field, { value, reason }]));
      if (this.updatesLoading) return all('Loading…', '');
      const history = orderedEntitlementHistory(this);
      if (history.reason) return all('Unavailable', history.reason);
      const config = this.memoryConfig;
      if (!config || !/^[1-9]\d*$/.test(config.baseProductId) ||
          !Array.isArray(config.versionProductIds) || !/^[1-9]\d*$/.test(config.leaseProductId)) {
        return all('Unavailable', 'Base, version or lease product configuration is unavailable.');
      }
      const features = Object.values(this.featureProductIds || {}).flatMap((ids) =>
        ids ? [ids.add, ids.remove].filter(Boolean) : []);
      const configuredIds = [config.baseProductId, config.leaseProductId, ...config.versionProductIds, ...features];
      if (configuredIds.some((id) => typeof id !== 'string' || !/^[1-9]\d*$/.test(id)) ||
          new Set(configuredIds).size !== configuredIds.length) {
        return all('Unavailable', 'Memory product configuration is invalid or ambiguous.');
      }
      const knownIds = new Set(configuredIds);
      let result = all('Unavailable', 'Base product memory is unavailable.');
      let segments = [];
      for (const entry of history.entries) {
        const products = entry.products;
        if (!products.length) {
          result = all('Unavailable', 'Entitlement products are missing.');
          continue;
        }
        const bases = products.filter((product) => String(product.productId) === config.baseProductId);
        if (bases.length > 1 || (bases.length && !Array.isArray(bases[0].memorySegments))) {
          result = all('Unavailable', 'Base product memory is missing or ambiguous.');
          segments = [];
        } else if (bases.length === 1) {
          segments = bases[0].memorySegments;
          const serial = EntitlementValues.decodeSerialNumber(segments);
          const expiry = EntitlementValues.decodeExpiryDate(segments, true);
          const version = EntitlementValues.decodeVersion(segments);
          result = {
            serial: { value: serial, reason: serial === 'Unavailable' ? 'Serial Number memory is missing or invalid.' : '' },
            expiry: { value: expiry, reason: expiry === 'Unavailable' ? 'Expiry Date memory is missing or invalid.' : '' },
            version: { value: version, reason: ['Unavailable', 'Invalid version data'].includes(version) ? 'Version memory is missing or invalid.' : '' },
          };
        }
        const productIds = products.map((product) => String(product.productId));
        if (productIds.some((id) => !knownIds.has(id))) {
          result = all('Unavailable', 'An unsupported product may modify base memory.');
          continue;
        }
        if (entry.type === 3 && !bases.length && productIds.includes(config.leaseProductId)) {
          result.expiry = { value: 'Unavailable', reason: 'The lease update does not include base expiry memory.' };
        }
        const versions = productIds.filter((id) => config.versionProductIds.includes(id));
        if (versions.length > 1) {
          result.version = { value: 'Unavailable', reason: 'The entitlement has conflicting version modifications.' };
        } else if (versions.length === 1) {
          const memory = this.versionProductMemory[versions[0]];
          try {
            if (!memory || memory.error) throw new Error(memory?.error || 'Version product memory is unavailable.');
            const write = EntitlementValues.versionWrite(segments, memory.files);
            const version = EntitlementValues.decodeVersion(segments, write);
            if (version === 'Unavailable' || version === 'Invalid version data') throw new Error('Invalid version write data.');
            result.version = { value: version, reason: '' };
          } catch (err) {
            result.version = { value: 'Unavailable', reason: 'Unable to reconstruct version: ' + err.message };
          }
        }
      }
      return result;
    },
    expectedFeatures() {
      const features = ['standalone', 'link', 'pivot'];
      const all = (value, reason) => Object.fromEntries([...features, 'lease'].map((name) => [name, { value, reason }]));
      if (this.updatesLoading) return all('Loading…', '');
      const history = orderedEntitlementHistory(this);
      if (history.reason) return all('Unavailable', history.reason);
      if (history.entries.some((entry) =>
        !entry.products.length || entry.products.some((product) => !/^[1-9]\d*$/.test(String(product.productId))))) {
        return all('Unavailable', 'Entitlement products are missing or ambiguous.');
      }
      const configured = this.featureProductIds || {};
      const knownIds = features.flatMap((name) => {
        const ids = configured[name];
        return ids ? [ids.add, ids.remove].filter((id) => typeof id === 'string' && /^[1-9]\d*$/.test(id)) : [];
      });
      if (Array.isArray(this.memoryConfig?.versionProductIds)) knownIds.push(...this.memoryConfig.versionProductIds);
      const baseId = this.memoryConfig?.baseProductId;
      const leaseId = this.memoryConfig?.leaseProductId;
      if (typeof baseId === 'string' && /^[1-9]\d*$/.test(baseId)) knownIds.push(baseId);
      if (typeof leaseId === 'string' && /^[1-9]\d*$/.test(leaseId)) knownIds.push(leaseId);
      if (new Set(knownIds).size !== knownIds.length) {
        return all('Unavailable', 'Feature product IDs are ambiguous.');
      }
      const result = Object.fromEntries(features.map((name) => {
        const ids = configured[name];
        if (!ids || !/^[1-9]\d*$/.test(ids.add) || (this.updates.length && !/^[1-9]\d*$/.test(ids.remove))) {
          return [name, { value: 'Unavailable', reason: 'Add and remove product IDs are not configured for this environment.' }];
        }
        if (ids.remove && this.originalEntitlement.products.some((product) => String(product.productId) === ids.remove)) {
          return [name, { value: 'Unavailable', reason: 'The original entitlement contains a removal for this feature.' }];
        }
        const present = this.originalEntitlement.products.some((product) => String(product.productId) === ids.add);
        return [name, { value: present ? 'Yes' : 'No', reason: '' }];
      }));
      result.lease = typeof leaseId === 'string' && /^[1-9]\d*$/.test(leaseId)
        ? { value: this.originalEntitlement.products.some((product) => String(product.productId) === leaseId) ? 'Yes' : 'No', reason: '' }
        : { value: 'Unavailable', reason: 'The lease product ID is not configured for this environment.' };
      for (const item of history.entries.slice(1)) {
        const products = item.products.map((product) => String(product.productId));
        if (products.some((id) => !knownIds.includes(id))) {
          return all('Unavailable', 'An update contains unsupported product modifications.');
        }
        if (!result.lease.reason && products.includes(leaseId)) result.lease.value = 'Yes';
        for (const name of features) {
          const ids = configured[name];
          if (result[name].reason) continue;
          if (products.includes(ids.add) && products.includes(ids.remove)) {
            result[name] = { value: 'Unavailable', reason: 'An update contains conflicting product modifications for this feature.' };
          } else if (products.includes(ids.add)) {
            result[name].value = 'Yes';
          } else if (products.includes(ids.remove)) {
            result[name].value = 'No';
          }
        }
      }
      return result;
    },
  },
  methods: {
    formatMemoryDate(value) {
      return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value.slice(8, 10)}-${value.slice(5, 7)}-${value.slice(0, 4)}` : value;
    },
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
            serialNumber: null, serialError: '', serials: [],
          });
        }
        const key = groups.get(groupId);
        const serial = String(activation.serialNumber ?? '').trim();
        if (serial && /^\d+$/.test(serial)) {
          if (!key.serials.includes(serial)) key.serials.push(serial);
        } else {
          key.serialError = activation.serialError || 'Original serial number is unavailable.';
        }
        for (const [field, value] of [
          ['customerNames', activation.customerName], ['productKeyIds', productKeyId], ['activationIds', activation.aid],
        ]) {
          const text = String(value ?? '').trim();
          if (text && !key[field].includes(text)) key[field].push(text);
        }
      }
      for (const key of groups.values()) {
        if (key.serials.length > 1) key.serialError = 'Conflicting serial numbers were returned for this protection key.';
        if (!key.serialError && key.serials.length === 1) key.serialNumber = key.serials[0];
        key.currentCustomer = key.protectionKeyId
          ? { value: 'Loading…', reason: '' }
          : { value: key.customerNames.join(', ') || 'Unavailable', reason: key.customerNames.length ? '' : 'Original customer is unavailable.' };
      }
      return [...groups.values()];
    },
    async loadCurrentCustomers(keys, request) {
      let customerList;
      const getCustomers = () => {
        if (!customerList) customerList = fetchCustomers();
        return customerList;
      };
      for (let index = 0; index < keys.length && request === this.listRequest; index += 5) {
        await Promise.all(keys.slice(index, index + 5).map(async (key) => {
          if (!key.protectionKeyId) return;
          try {
            const data = await fetchKeyTimeline(key.protectionKeyId);
            if (request !== this.listRequest) return;
            if (data.originalError) throw new Error(data.originalError);
            const counters = await fetchKeyCounters(key.protectionKeyId);
            if (request !== this.listRequest) return;
            const history = orderedEntitlementHistory({
              originalEntitlement: data.original, originalError: data.originalError, updates: data.updates,
              counterHistory: counters,
            });
            if (history.reason) throw new Error(history.reason);
            const latest = history.entries[history.entries.length - 1];
            let name = customerText(latest.customer);
            if (!name) {
              const customerId = String(latest.customerId ?? '').trim();
              if (!/^[1-9]\d*$/.test(customerId)) throw new Error('The latest entitlement customer is unavailable.');
              name = findCustomerName(await getCustomers(), customerId);
            }
            if (request === this.listRequest) key.currentCustomer = { value: name, reason: '' };
          } catch (err) {
            if (request === this.listRequest) key.currentCustomer = { value: 'Unavailable', reason: err.message };
          }
        }));
      }
    },
    async selectKey(key) {
      const request = ++this.selectionRequest;
      this.selectedKey = key;
      this.updates = [];
      this.originalEntitlement = null;
      this.originalError = '';
      this.updatesError = '';
      this.counterWarning = '';
      this.featureProductIds = null;
      this.counterHistory = null;
      this.customerLookup = null;
      this.memoryConfig = null;
      this.versionProductMemory = {};
      this.updatesLoading = false;
      if (!key.protectionKeyId) return;
      this.updatesLoading = true;
      try {
        const data = await fetchKeyTimeline(key.protectionKeyId);
        if (request !== this.selectionRequest) return;
        this.originalEntitlement = data.original;
        this.originalError = data.originalError;
        this.updates = data.updates;
        this.featureProductIds = data.featureProductIds || null;
        this.memoryConfig = {
          baseProductId: data.baseProductId,
          versionProductIds: data.versionProductIds,
          leaseProductId: data.leaseProductId,
        };
        if (data.updates.length || data.original) {
          try {
            const history = await fetchKeyCounters(key.protectionKeyId);
            if (request !== this.selectionRequest) return;
            this.counterHistory = history;
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
        if (request !== this.selectionRequest) return;
        const history = orderedEntitlementHistory(this);
        if (history.entries && Array.isArray(this.memoryConfig.versionProductIds)) {
          const versionIds = [...new Set(history.entries.flatMap((entry) => entry.products
            .map((product) => String(product.productId))
            .filter((id) => this.memoryConfig.versionProductIds.includes(id))))];
          const memories = await Promise.all(versionIds.map(async (id) => {
            try {
              const response = await fetch(`/api/catalog/products/${encodeURIComponent(id)}/read-only-memory`, { cache: 'no-store' });
              const files = await response.json();
              if (!response.ok) throw new Error(files.error || response.statusText);
              if (!Array.isArray(files)) throw new Error('Invalid version product memory.');
              return [id, { files }];
            } catch (err) {
              return [id, { error: err.message }];
            }
          }));
          if (request !== this.selectionRequest) return;
          this.versionProductMemory = Object.fromEntries(memories);
        }
        const latest = history.entries?.[history.entries.length - 1];
        const customerId = String(latest?.customerId ?? '').trim();
        if (latest && !customerText(latest.customer) && /^[1-9]\d*$/.test(customerId)) {
          try {
            const name = findCustomerName(await fetchCustomers(), customerId);
            if (request === this.selectionRequest) this.customerLookup = { id: customerId, name };
          } catch (err) {
            if (request === this.selectionRequest) this.customerLookup = { id: customerId, error: 'Unable to load the latest entitlement customer: ' + err.message };
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
      const request = ++this.listRequest;
      this.loading = true;
      this.error = '';
      this.associationError = '';
      const selectedId = this.selectedKey?.groupId;
      this.selectionRequest++;
      this.selectedKey = null;
      this.updates = [];
      this.originalEntitlement = null;
      this.originalError = '';
      this.updatesLoading = false;
      this.updatesError = '';
      this.counterWarning = '';
      this.featureProductIds = null;
      this.counterHistory = null;
      this.customerLookup = null;
      this.memoryConfig = null;
      this.versionProductMemory = {};
      try {
        const response = await fetch('/api/activations', { cache: 'no-store' });
        const data = await response.json();
        if (request !== this.listRequest) return;
        if (!response.ok) throw new Error(data.error || response.statusText);
        if (!Array.isArray(data.activations)) throw new Error('The server returned an invalid activations list');
        if (data.activations.some((activation) => !activation || typeof activation.productKeyId !== 'string' || !activation.productKeyId.trim())) {
          throw new Error('The server returned an activation without a product key ID');
        }
        this.activations = data.activations;
        this.keys = this.groupKeys(data.activations);
        let associatedKeys = null;
        if (this.associatedEntitlementId) {
          try {
            if (!/^[1-9]\d*$/.test(this.associatedEntitlementId)) throw new Error('Invalid entitlement ID.');
            const associationResponse = await fetch(`/api/entitlements/${encodeURIComponent(this.associatedEntitlementId)}/protection-keys`, { cache: 'no-store' });
            const association = await associationResponse.json();
            if (!associationResponse.ok) throw new Error(association.error || associationResponse.statusText);
            if (!Array.isArray(association.protectionKeyIds) || association.protectionKeyIds.some((id) =>
              typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))) {
              throw new Error('The server returned invalid protection key IDs.');
            }
            const ids = [...new Set(association.protectionKeyIds)];
            if (!ids.length) throw new Error('No protection key ID is available for this entitlement.');
            if (request !== this.listRequest) return;
            if (ids.some((id) => !this.keys.some((key) => key.protectionKeyId === id))) {
              throw new Error('Some associated protection keys were not found in the key list.');
            }
            associatedKeys = this.keys.filter((key) => ids.includes(key.protectionKeyId));
            this.associatedEntitlementId = '';
          } catch (err) {
            if (request !== this.listRequest) return;
            this.associationError = 'Unable to find protection keys: ' + err.message;
          }
        }
        this.loadCurrentCustomers(this.keys, request);
        const selected = this.associationError ? null : associatedKeys
          ? associatedKeys.find((key) => key.groupId === selectedId) || associatedKeys[0]
          : this.keys.find((key) => key.groupId === selectedId) || this.keys[0];
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
        if (request === this.listRequest) this.error = 'Failed to load activations: ' + err.message;
      } finally {
        if (request === this.listRequest) this.loading = false;
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
    this.associatedEntitlementId = new URLSearchParams(window.location.search).get('entitlementId') || '';
    this.loadActivations();
  },
}).mount('#app');
