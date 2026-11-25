const { createApp } = Vue;
createApp({
  data() {
    return {
      entitlements: [],
      customers: [],
      selectedEntitlement: null,
      detailsConfirmed: false,
      detailsConfirmationTimeout: null,
      productKeys: [],
      productKeyLoading: false,
      productKeyError: '',
      historyPackages: {},
      activating: false,
      activationError: '',
      activationUncertainKeys: [],
      activationDownloads: [],
      productKeyFields: [
        { name: 'productKeyId', label: 'Product Key' },
        { name: 'totalEntitled', label: 'Total entitled' },
        { name: 'available', label: 'Available' },
        { name: 'enabled', label: 'Enabled' },
        { name: 'type', label: 'Type' },
        { name: 'registrationRequired', label: 'Registration required' },
        { name: 'customerEmail', label: 'Customer email' },
        { name: 'customerName', label: 'Customer name' },
        { name: 'entitlementId', label: 'Entitlement ID' },
        { name: 'customerId', label: 'Customer ID' },
      ],
      versionMemory: null,
      versionError: '',
      detailRequest: 0,
      detailLoading: false,
      deleting: false,
      producing: false,
      produceUncertain: false,
      produceError: '',
      reopening: false,
      reopenUncertain: false,
      reopenError: '',
      detailError: '',
      loading: false,
      customersLoading: false,
      error: '',
      customerError: '',
      notice: '',
      filter: '',
    };
  },
  computed: {
    isProductKeyGenerated() {
      return String(this.selectedEntitlement?.entState ?? '').toUpperCase() === 'PRODUCT_KEY_GENERATED';
    },
    isEntitlementComplete() {
      return String(this.selectedEntitlement?.entState ?? '').toUpperCase() === 'COMPLETED';
    },
    canReopen() {
      return ['PRODUCT_KEY_GENERATED', 'QUEUED'].includes(
        String(this.selectedEntitlement?.entState ?? '').toUpperCase()
      );
    },
    canDelete() {
      return String(this.selectedEntitlement?.entState || this.selectedEntitlement?.state || '').toUpperCase() === 'DRAFT';
    },
    canProduce() {
      const entitlement = this.selectedEntitlement;
      return String(entitlement?.entState ?? '').toUpperCase() === 'DRAFT' &&
        Array.isArray(entitlement.lineItemTypes) && entitlement.lineItemTypes.length > 0 &&
        entitlement.lineItemTypes.every((type) => type === 'Product_Key');
    },
    status() {
      if (this.detailLoading) return 'Loading entitlement details…';
      if (this.loading) return 'Loading entitlements…';
      if (this.error) return this.error;
      if (this.notice) return this.notice;
      return '';
    },
    baseMemorySegments() {
      const base = (this.selectedEntitlement?.products || [])
        .find((product) => String(product.productId) === String(this.selectedEntitlement.baseProductId));
      return base?.memorySegments || [];
    },
    selectedSerialNumber() {
      const segments = this.baseMemorySegments.filter((segment) =>
        segment.saot && typeof segment.name === 'string' &&
        segment.name.trim().toLowerCase() === 'serial number'
      );
      if (segments.length !== 1) return 'Unavailable';
      const text = String(segments[0].text ?? '').trim();
      if (!/^(?:[0-9a-f]{2})+$/i.test(text)) return 'Unavailable';
      const digits = text.match(/../g).map((pair) => String.fromCharCode(parseInt(pair, 16))).join('');
      if (!/^[0-9a-f]+$/i.test(digits)) return 'Unavailable';
      return BigInt(`0x${digits}`).toString().padStart(5, '0');
    },
    selectedExpiryDate() {
      const hasLeaseProduct = (this.selectedEntitlement?.products || []).some((product) =>
        String(product.productId) === String(this.selectedEntitlement.leaseProductId)
      );
      if (!hasLeaseProduct) return 'N/A (Not Lease)';
      const segments = this.baseMemorySegments.filter((segment) =>
        typeof segment.name === 'string' &&
        segment.name.trim().toLowerCase() === 'expiry date'
      );
      if (segments.length !== 1) return 'Unavailable';
      const text = String(segments[0].text ?? '').trim();
      if (!/^(?:[0-9a-f]{2})+$/i.test(text)) return 'Unavailable';
      const candidates = [];
      const decoded = text.match(/../g).map((pair) => String.fromCharCode(parseInt(pair, 16))).join('');
      if (/^[0-9a-f]{4}$/i.test(decoded)) candidates.push(parseInt(decoded, 16));
      const raw = parseInt(text, 16);
      if (text.length <= 8 && raw <= 0xFFFF) candidates.push(raw);
      for (const value of candidates) {
        const year = (value >> 9) + 1980;
        const month = (value >> 5) & 0xF;
        const day = value & 0x1F;
        const date = new Date(Date.UTC(year, month - 1, day));
        if (value && month >= 1 && month <= 12 && day >= 1 &&
            date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
            date.getUTCDate() === day) {
          return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
      }
      return 'Unavailable';
    },
    selectedProductAttributes() {
      const products = this.selectedEntitlement?.products || [];
      const aliases = this.selectedEntitlement?.productAliases || [];
      return aliases.filter((attribute) => attribute.group !== 'version').map((attribute) => ({
        ...attribute,
        present: products.some((product) => String(product.productId) === String(attribute.id)),
      }));
    },
    decodedVersion() {
      if (this.versionError) return this.versionError;
      const segments = this.baseMemorySegments.filter((segment) =>
        typeof segment.name === 'string' && segment.name.trim().toLowerCase() === 'version'
      );
      if (!segments.length) return 'Unavailable';
      if (segments.length !== 1) return 'Invalid version data';
      const text = String((this.versionMemory ? this.versionMemory.content : segments[0].text) ?? '').trim();
      if (!/^[0-9a-f]{8}$/i.test(text)) return 'Invalid version data';
      const versionHex = text.match(/../g).map((pair) => String.fromCharCode(parseInt(pair, 16))).join('');
      if (!/^[0-9a-f]{4}$/i.test(versionHex)) return 'Invalid version data';
      return 'v' + ((parseInt(versionHex, 16) ^ 0xBEAD) / 1000);
    },
    filteredEntitlements() {
      const query = this.filter.toLocaleLowerCase();
      if (!query) return this.entitlements;
      return this.entitlements.filter((entitlement) => {
        const values = [];
        const collectValues = (value) => {
          if (value === null || value === undefined) return;
          if (typeof value === 'object') {
            Object.values(value).forEach(collectValues);
          } else {
            values.push(String(value));
          }
        };
        collectValues(entitlement);
        collectValues(this.typeLabel(entitlement.type));
        return values.some((value) => value.toLocaleLowerCase().includes(query));
      });
    },
  },
  methods: {
    protectionKeyIds(key) {
      return [...new Set((key.activationReferences || [])
        .map((reference) => reference.protectionKeyId)
        .filter((id) => typeof id === 'string' && id.trim())
        .map((id) => id.trim()))];
    },
    async downloadHistoryPackage(id) {
      if (!id || this.historyPackages[id]?.loading) return;
      const state = { loading: true, error: '' };
      this.historyPackages[id] = state;
      const request = this.detailRequest;
      try {
        const packageXml = await V2cpDownload.fetchPackage(id);
        if (request === this.detailRequest) V2cpDownload.downloadPackage(id, packageXml);
      } catch (err) {
        if (request === this.detailRequest) state.error = 'Failed to build V2CP: ' + err.message;
      } finally {
        state.loading = false;
      }
    },
    licenseDownloadUrl(license) {
      return 'data:application/xml;charset=utf-8,' + encodeURIComponent(license);
    },
    async activateProductKey(key, event) {
      const file = event.target.files[0];
      event.target.value = '';
      if (!file || this.activating || this.loading || this.deleting || this.reopening ||
          !this.isProductKeyGenerated || this.activationUncertainKeys.includes(key.productKeyId)) return;
      this.activationError = '';
      if (!/\.c2v$/i.test(file.name) || !file.size || file.size > 10 * 1024 * 1024) {
        this.activationError = 'Choose a non-empty C2V file no larger than 10 MB.';
        return;
      }
      if (!window.confirm('Activate product key ' + key.productKeyId + ' using the selected C2V file?')) return;
      this.activating = true;
      let outcomeUnknown = false;
      try {
        const c2v = await file.text();
        outcomeUnknown = true;
        const response = await fetch(`/api/entitlements/${encodeURIComponent(this.selectedEntitlement.id)}/activate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productKeyId: key.productKeyId, c2v }),
        });
        const data = await response.json();
        if (!response.ok) {
          outcomeUnknown = data.outcomeUnknown !== false;
          throw new Error(data.error || response.statusText);
        }
        if (typeof data.aid !== 'string' || !data.aid || typeof data.license !== 'string' || !data.license) {
          throw new Error('The server returned an invalid activation result.');
        }
        this.activationDownloads.push({ aid: data.aid, license: data.license });
        this.notice = 'Activation completed. Download the V2C file below.';
      } catch (err) {
        if (outcomeUnknown) this.activationUncertainKeys.push(key.productKeyId);
        this.activationError = 'Failed to activate: ' + err.message;
      } finally {
        this.activating = false;
      }
    },
    productKeyDownloadUrl(key) {
      return 'data:text/plain;charset=utf-8,' + encodeURIComponent(key);
    },
    productKeyFilename(key) {
      const safe = (value) => String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '') || 'Unknown';
      const customer = key.customerName || this.selectedEntitlement?.customerName || this.selectedEntitlement?.customer || 'Unknown';
      return `Product Key - ${safe(customer)}.txt`;
    },
    async openEntitlementDetails(entitlement) {
      if (this.producing || this.activating) return;
      const request = ++this.detailRequest;
      this.clearDetailsConfirmation();
      this.productKeys = [];
      this.productKeyError = '';
      this.productKeyLoading = false;
      this.historyPackages = {};
      this.activationError = '';
      this.activationDownloads = [];
      this.reopenError = '';
      this.reopenUncertain = false;
      this.produceError = '';
      this.produceUncertain = false;
      this.detailError = '';
      this.versionError = '';
      this.versionMemory = null;
      this.selectedEntitlement = { ...entitlement, products: [] };
      this.detailLoading = true;
      try {
        const response = await fetch(`/api/entitlements/${encodeURIComponent(entitlement.id)}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        if (!Array.isArray(data.products)) throw new Error('The server returned invalid entitlement details');
        if (request !== this.detailRequest) return;
        const customerId = data.customerId ?? entitlement.customerId;
        const customer = this.customers.find((item) =>
          String(item.customerId ?? item.id ?? '') === String(customerId ?? '')
        );
        this.selectedEntitlement = {
          ...data,
          customerName: customer?.name ?? customer?.customerName ??
            data.customerName ?? data.customer ?? entitlement.customer,
        };
        if (['PRODUCT_KEY_GENERATED', 'COMPLETED'].includes(String(data.entState ?? '').toUpperCase())) {
          await this.loadProductKeys(entitlement.id, request);
        }
        try {
          const memory = await this.loadVersionMemory(data);
          if (request === this.detailRequest) this.versionMemory = memory;
        } catch (err) {
          if (request === this.detailRequest) this.versionError = 'Unable to determine effective version: ' + err.message;
        }
      } catch (err) {
        if (request === this.detailRequest) this.detailError = 'Failed to load entitlement details: ' + err.message;
      } finally {
        if (request === this.detailRequest) this.detailLoading = false;
      }
    },
    async loadProductKeys(id, request) {
      this.productKeyLoading = true;
      this.productKeyError = '';
      try {
        const response = await fetch(`/api/entitlements/${encodeURIComponent(id)}/product-keys`, { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        if (!Array.isArray(data) || !data.length) throw new Error('The server returned invalid product key details');
        if (request === this.detailRequest) this.productKeys = data;
      } catch (err) {
        if (request === this.detailRequest) this.productKeyError = 'Failed to load product key details: ' + err.message;
      } finally {
        if (request === this.detailRequest) this.productKeyLoading = false;
      }
    },
    async produceSelectedEntitlement() {
      const entitlement = this.selectedEntitlement;
      if (!entitlement || !this.canProduce || !this.detailsConfirmed || this.loading || this.producing || this.deleting || this.produceUncertain || this.detailLoading || this.detailError) return;
      if (!window.confirm('Produce entitlement ' + entitlement.id + '? This generates product keys and the entitlement can no longer be edited as a draft.')) return;
      this.clearDetailsConfirmation();
      this.producing = true;
      this.produceError = '';
      let outcomeUnknown = true;
      try {
        const response = await fetch(`/api/entitlements/${encodeURIComponent(entitlement.id)}/produce`, { method: 'POST' });
        const data = await response.json();
        if (!response.ok) {
          outcomeUnknown = data.outcomeUnknown !== false;
          throw new Error(data.error || response.statusText);
        }
        this.selectedEntitlement.entState = data.state;
        this.notice = 'Entitlement ' + entitlement.id + ' produced.';
        this.producing = false;
        await this.loadEntitlements();
      } catch (err) {
        this.produceUncertain = outcomeUnknown;
        this.produceError = outcomeUnknown
          ? 'Unable to confirm production: ' + err.message + ' Reload the entitlement before retrying.'
          : 'Failed to produce entitlement: ' + err.message;
      } finally {
        this.producing = false;
      }
    },
    async deleteSelectedEntitlement() {
      const entitlement = this.selectedEntitlement;
      if (!entitlement || !this.canDelete || this.deleting || this.activating) return;
      const name = this.displayValue(entitlement.customerName || entitlement.customer || entitlement.customerId);
      if (!window.confirm('Delete entitlement ' + entitlement.id + ' for ' + name + '? This cannot be undone.')) return;
      this.deleting = true;
      this.error = '';
      this.notice = '';
      try {
        const response = await fetch('/api/entitlements/' + encodeURIComponent(entitlement.id), { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        this.selectedEntitlement = null;
        this.notice = 'Entitlement ' + entitlement.id + ' deleted.';
        await this.loadEntitlements();
      } catch (err) {
        this.error = 'Failed to delete entitlement: ' + err.message;
      } finally {
        this.deleting = false;
      }
    },
    async reopenSelectedEntitlement() {
      const entitlement = this.selectedEntitlement;
      if (!entitlement || !this.canReopen || this.reopening || this.deleting ||
          this.producing || this.activating || this.loading || this.reopenUncertain) return;
      const name = this.displayValue(entitlement.customerName || entitlement.customer || entitlement.customerId);
      if (!window.confirm('Reopen entitlement ' + entitlement.id + ' for ' + name + '? This changes its state back to DRAFT. The product key and its text file will become invalid.')) return;
      this.reopening = true;
      this.reopenError = '';
      let outcomeUnknown = true;
      try {
        const response = await fetch(`/api/entitlements/${encodeURIComponent(entitlement.id)}/reopen`, { method: 'POST' });
        const data = await response.json();
        if (!response.ok) {
          outcomeUnknown = data.outcomeUnknown !== false;
          throw new Error(data.error || response.statusText);
        }
        outcomeUnknown = false;
        this.selectedEntitlement.entState = data.state;
        this.productKeys = [];
        this.clearDetailsConfirmation();
        this.notice = 'Entitlement ' + entitlement.id + ' reopened as a draft.';
        this.reopening = false;
        await this.loadEntitlements();
      } catch (err) {
        this.reopenUncertain = outcomeUnknown;
        this.reopenError = outcomeUnknown
          ? 'Unable to confirm reopening: ' + err.message + ' Reload the entitlement before retrying.'
          : 'Failed to reopen entitlement: ' + err.message;
      } finally {
        this.reopening = false;
      }
    },
    confirmDetailsReviewed() {
      if (!this.canProduce || this.detailsConfirmed || this.detailLoading || this.detailError) return;
      this.detailsConfirmed = true;
      this.detailsConfirmationTimeout = window.setTimeout(() => {
        this.detailsConfirmed = false;
        this.detailsConfirmationTimeout = null;
      }, 5000);
    },
    clearDetailsConfirmation() {
      if (this.detailsConfirmationTimeout !== null) {
        window.clearTimeout(this.detailsConfirmationTimeout);
      }
      this.detailsConfirmationTimeout = null;
      this.detailsConfirmed = false;
    },
    /** Find the fixed modification write that exactly covers the base Version segment. */
    async loadVersionMemory(entitlement) {
      if (!Array.isArray(entitlement.versionProductIds)) {
        throw new Error('version product configuration is missing');
      }
      const selected = entitlement.products.filter((product) =>
        entitlement.versionProductIds.includes(String(product.productId))
      );
      if (!selected.length) return;
      if (selected.length !== 1) throw new Error('multiple version products are selected');
      const base = entitlement.products.find((product) => String(product.productId) === String(entitlement.baseProductId));
      const versions = (base?.memorySegments || []).filter((segment) =>
        typeof segment.name === 'string' && segment.name.trim().toLowerCase() === 'version'
      );
      if (versions.length !== 1) throw new Error('the base Version segment is missing or ambiguous');
      const offset = (value) => {
        const text = String(value ?? '').trim();
        return /^(?:0x[0-9a-f]+|\d+)$/i.test(text) ? Number(text) : NaN;
      };
      const baseOffset = offset(versions[0].offset);
      const baseSize = Number(versions[0].size);
      if (!Number.isSafeInteger(baseOffset) || !Number.isSafeInteger(baseSize) || baseSize !== 4) {
        throw new Error('the base Version segment has invalid memory metadata');
      }
      const response = await fetch(`/api/catalog/products/${encodeURIComponent(selected[0].productId)}/read-only-memory`);
      const files = await response.json();
      if (!response.ok) throw new Error(files.error || response.statusText);
      if (!Array.isArray(files)) throw new Error('invalid version product memory');
      const writes = files.filter((file) => file.kind === 'product').flatMap((file) => {
        if (!Array.isArray(file.segments)) throw new Error('invalid version product memory segments');
        return file.segments;
      });
      const overlaps = writes.filter((segment) => {
        const start = offset(segment.offset);
        const size = Number(segment.size);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || size <= 0) {
          throw new Error('invalid version product memory metadata');
        }
        return start < baseOffset + baseSize && baseOffset < start + size;
      });
      if (overlaps.length !== 1 || offset(overlaps[0].offset) !== baseOffset ||
          Number(overlaps[0].size) !== baseSize || overlaps[0].saot !== false) {
        throw new Error('the version product does not contain one complete fixed Version write');
      }
      return overlaps[0];
    },
    async loadCustomers() {
      this.customersLoading = true;
      this.customerError = '';
      try {
        const response = await fetch('/api/customers');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        if (!Array.isArray(data)) throw new Error('The server returned an invalid customer list');
        this.customers = data;
      } catch (err) {
        this.customerError = 'Failed to load EMS customers: ' + err.message;
      } finally {
        this.customersLoading = false;
      }
    },
    isDraftEntitlement(entitlement) {
      return String(entitlement?.state ?? '').toUpperCase() === 'DRAFT';
    },
    openEditEntitlement(entitlement) {
      if (!this.isDraftEntitlement(entitlement)) return;
      window.location.assign('/update-entitlement-form.html?id=' + encodeURIComponent(entitlement.id));
    },
    openCreateEntitlement() {
      window.location.assign('/create-entitlement-form.html');
    },
    statusTagClass(state) {
      const key = String(state ?? '').trim().toLowerCase();
      const known = ['complete', 'draft', 'acknowledged', 'queued', 'produced'];
      const aliases = { acknowleged: 'acknowledged', qued: 'queued', completed: 'complete' };
      const name = aliases[key] || key;
      return known.includes(name) ? 'status-' + name : 'status-unknown';
    },
    productPresent(alias) {
      const attribute = this.selectedProductAttributes.find((item) => item.alias === alias);
      return attribute && attribute.present ? 'Yes' : 'No';
    },
    typeLabel(type) {
      const labels = { 1: 'HL Key', 2: 'Product Key', 3: 'Key Update' };
      return labels[String(type).trim()] ?? type;
    },
    typeMarkerClass(type) {
      return { 2: 'product-key', 3: 'key-update' }[String(type).trim()] ?? 'other';
    },
    hexValue(segment) {
      const text = String(segment.text ?? '').trim();
      if (!/^[0-9a-f]*$/i.test(text)) return this.displayValue(text);
      const digits = Number(segment.size) * 2;
      return (Number.isInteger(digits) && digits > 0 ? text.padStart(digits, '0') : text).toUpperCase() || '—';
    },
    memoryAccess(segment) {
      if (!Array.isArray(segment.memoryTypes) || !segment.memoryTypes.length ||
          segment.memoryTypes.some((type) => !['1', '2'].includes(type))) return 'Unavailable';
      return [...new Set(segment.memoryTypes.map((type) => type === '1' ? 'R/W' : 'RO'))].join(', ');
    },
    asciiHexValue(segment) {
      const text = String(segment.text ?? '').trim();
      if (!text || !/^[0-9a-f]+$/i.test(text)) return 'Unavailable';
      const hex = this.hexValue(segment);
      if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return 'Unavailable';
      return hex.match(/../g).map((pair) => {
        const byte = parseInt(pair, 16);
        return byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '\\x' + pair;
      }).join('');
    },
    displayValue(value) {
      return value === null || value === undefined || value === '' ? '—' : String(value);
    },
    formatLocalDate(value, utc = false) {
      const text = this.displayValue(value);
      if (text === '—') return text;
      const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
      let localDate = text;
      if (!dateOnly) {
        const dateTime = /^(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;
        if (!dateTime.test(text)) return text;
        const isoText = text.includes('T') ? text : text.replace(' ', 'T');
        const instant = new Date(isoText);
        if (Number.isNaN(instant.getTime())) return text;
        localDate = utc ? instant.toISOString().slice(0, 10)
          : `${instant.getFullYear()}-${String(instant.getMonth() + 1).padStart(2, '0')}-${String(instant.getDate()).padStart(2, '0')}`;
      }
      const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
      return date ? `${date[3]}-${date[2]}-${date[1]}` : text;
    },
    formatUtcDate(value) {
      return this.formatLocalDate(value, true);
    },
    formatEndDate(value) {
      const date = this.formatLocalDate(value);
      return date === '31-12-2500' ? 'Never' : date;
    },
    highlightParts(value) {
      const text = this.displayValue(value);
      const query = this.filter.trim();
      if (!query) return [{ text, highlighted: false }];

      const lowerText = text.toLocaleLowerCase();
      const lowerQuery = query.toLocaleLowerCase();
      const parts = [];
      let cursor = 0;
      let matchIndex = lowerText.indexOf(lowerQuery, cursor);
      while (matchIndex !== -1) {
        if (matchIndex > cursor) parts.push({ text: text.slice(cursor, matchIndex), highlighted: false });
        parts.push({ text: text.slice(matchIndex, matchIndex + query.length), highlighted: true });
        cursor = matchIndex + query.length;
        matchIndex = lowerText.indexOf(lowerQuery, cursor);
      }
      if (cursor < text.length) parts.push({ text: text.slice(cursor), highlighted: false });
      return parts.length ? parts : [{ text, highlighted: false }];
    },
    async loadEntitlements() {
      if (this.activating) return;
      this.loading = true;
      this.error = '';
      try {
        const response = await fetch('/api/entitlements');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        if (!Array.isArray(data)) throw new Error('The server returned an invalid entitlements list');
        this.entitlements = data;
        const selectedId = this.selectedEntitlement?.id ?? this.selectedEntitlement?.entitlementId;
        const defaultEntitlement = this.entitlements.find((entitlement) =>
          String(entitlement.id ?? entitlement.entitlementId) === String(selectedId)
        ) || this.entitlements[0];
        if (defaultEntitlement) {
          await this.openEntitlementDetails(defaultEntitlement);
        } else {
          this.selectedEntitlement = null;
          this.detailError = '';
        }
      } catch (err) {
        this.error = 'Failed to load entitlements: ' + err.message;
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
    const params = new URLSearchParams(window.location.search);
    if (params.has('created')) {
      const serialWarning = params.get('serialWarning');
      this.notice = serialWarning
        ? 'Entitlement saved as a draft, but the serial number could not be advanced: ' + serialWarning
        : 'Entitlement saved as a draft.';
    } else if (params.has('updated')) this.notice = 'Entitlement updated.';
    this.loadEntitlements();
    this.loadCustomers();
  },
}).mount('#app');
