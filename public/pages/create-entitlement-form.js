const { createApp } = Vue;
const DEFAULT_LEASE_LENGTH_YEARS = 1;
const FIRST_SERIAL_NUMBER = 6001;
const MAX_SERIAL_NUMBER = 65535;

createApp({
  components: { SerialNumberInput },
  data() {
    return {
      customers: [],
      customerSearch: '',
      customerSearchOpen: false,
      products: [],
      accessProducts: [],
      optionalProducts: [],
      versionProducts: [],
      defaultVersionLabel: 'Default',
      leaseExpiryDate: '',
      leaseExpiryRange: null,
      serialNumber: '',
      serialLoading: false,
      serialError: '',
      usedSerialNumbers: [],
      baseProductId: '',
      productMemory: {},
      loading: false,
      customersLoading: false,
      productsLoading: false,
      error: '',
      customerError: '',
      productError: '',
      form: this.createEmptyForm(),
    };
  },
  computed: {
    filteredCustomers() {
      const query = this.customerSearch.trim().toLocaleLowerCase();
      return this.customers.filter((customer) => this.customerLabel(customer).toLocaleLowerCase().includes(query));
    },
    status() {
      if (this.loading) return 'Saving entitlement…';
      if (this.error) return this.error;
      return '';
    },
    hasAccessProduct() {
      return this.accessProducts.some((product) => this.form.productIds.includes(product.id));
    },
    leaseProduct() {
      return this.optionalProducts.find((product) => product.lease);
    },
    otherOptionalProducts() {
      return this.optionalProducts.filter((product) => product !== this.leaseProduct);
    },
    leaseSelected() {
      return Boolean(this.leaseProduct && this.form.productIds.includes(this.leaseProduct.id));
    },
    leaseBounds() {
      const now = new Date();
      return LeaseDates.bounds(this.utcToday(now), this.localToday(now), this.leaseExpiryRange);
    },
    selectedVersionId() {
      return this.versionProducts.find((product) => this.form.productIds.includes(product.id))?.id || '';
    },
    baseExpirySegment() {
      const files = this.productMemory[this.baseProductId]?.files || [];
      const segments = files.filter((file) => file.kind === 'product')
        .flatMap((file) => file.segments)
        .filter((segment) => segment.saot && typeof segment.name === 'string' &&
          segment.name.trim().toLowerCase() === 'expiry date');
      return segments.length === 1 ? segments[0] : null;
    },
    baseSerialSegment() {
      const files = this.productMemory[this.baseProductId]?.files || [];
      const segments = files.filter((file) => file.kind === 'product')
        .flatMap((file) => file.segments)
        .filter((segment) => this.isSerialSegment(segment));
      return segments.length === 1 ? segments[0] : null;
    },
    serialMax() {
      const digits = Number(this.baseSerialSegment?.size);
      return Number.isInteger(digits) && digits > 0 ? 16n ** BigInt(digits) - 1n : 0n;
    },
    serialTooLarge() {
      return /^\d+$/.test(this.serialNumber) && BigInt(this.serialNumber) > this.serialMax;
    },
    serialTooSmall() {
      return /^\d+$/.test(this.serialNumber) && BigInt(this.serialNumber) < 6000n;
    },
    serialUsed() {
      return /^\d+$/.test(this.serialNumber) && this.usedSerialNumbers.includes(Number(this.serialNumber));
    },
    memoryProductIds() {
      return this.baseProductId ? [this.baseProductId, ...this.form.productIds] : [];
    },
    productMemoryReady() {
      return Boolean(this.baseProductId) && Boolean(this.baseSerialSegment) && (!this.leaseSelected || (this.baseExpirySegment && Number(this.baseExpirySegment.size) === 4)) && this.memoryProductIds.every((id) => {
        const state = this.productMemory[id];
        return state && !state.loading && !state.error &&
          !state.files.some((file) => file.kind !== 'product' && file.segments.some((segment) => segment.saot));
      });
    },
  },
  methods: {
    customerLabel(customer) {
      return String(customer.name || customer.customerName || ('Customer ' + customer.customerId));
    },
    toggleCustomerSearch() {
      this.customerSearchOpen = !this.customerSearchOpen;
      if (this.customerSearchOpen) {
        this.$nextTick(() => this.$refs.customerSearchInput.focus());
      } else {
        this.customerSearch = '';
      }
    },
    filterCustomerSelection() {
      if (this.form.customerId && !this.filteredCustomers.some((customer) => String(customer.customerId) === this.form.customerId)) {
        this.form.customerId = '';
      }
    },
    createEmptyForm() {
      return {
        customerId: '',
        productIds: [],
        refId1: '',
        description: '',
      };
    },
    localToday(now = new Date()) {
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    },
    utcToday(now = new Date()) {
      return now.toISOString().slice(0, 10);
    },
    isCheckboxProduct(productId) {
      return [...this.accessProducts, ...this.optionalProducts].some((product) => product.id === productId);
    },
    isChoiceProduct(productId) {
      return this.isCheckboxProduct(productId) || this.versionProducts.some((product) => product.id === productId);
    },
    setVersionProduct(productId) {
      if (productId && !this.versionProducts.some((product) => product.id === productId && product.available)) return;
      if (productId === this.selectedVersionId) return;
      if (productId && this.form.productIds.length >= 99 && !this.selectedVersionId) {
        this.error = 'A maximum of 99 modification products can be added.';
        return;
      }
      for (const product of this.versionProducts) {
        if (this.form.productIds.includes(product.id)) this.removeProduct(product.id);
      }
      if (productId) {
        this.form.productIds.push(productId);
        this.loadProductMemory(productId);
      }
    },
    isBaseExpirySegment(productId, file, segment) {
      return productId === this.baseProductId && file.kind === 'product' && segment.saot &&
        typeof segment.name === 'string' && segment.name.trim().toLowerCase() === 'expiry date';
    },
    isSerialSegment(segment) {
      return Boolean(segment.saot) && typeof segment.name === 'string' &&
        segment.name.trim().toLowerCase() === 'serial number';
    },
    isBaseSerialSegment(productId, file, segment) {
      return productId === this.baseProductId && file.kind === 'product' && this.isSerialSegment(segment);
    },
    encodeSerialNumber: EntitlementValues.encodeSerialNumber,
    defaultLeaseExpiryDate(today = new Date()) {
      const start = this.utcToday(today);
      const { min, max } = LeaseDates.bounds(start, this.localToday(today), this.leaseExpiryRange);
      if (min > max) return '';
      return [min, LeaseDates.addMonths(start, DEFAULT_LEASE_LENGTH_YEARS * 12), max].sort()[1];
    },
    encodeLeaseExpiryDate: EntitlementValues.encodeLeaseExpiryDate,
    setCheckboxProduct(productId, checked) {
      if (!this.isCheckboxProduct(productId)) return;
      if (checked && this.optionalProducts.some((product) => product.id === productId && !product.available)) return;
      if (checked && !this.form.productIds.includes(productId)) {
        if (this.form.productIds.length >= 99) {
          this.error = 'A maximum of 99 modification products can be added.';
          return;
        }
        this.form.productIds.push(productId);
        if (productId === this.leaseProduct?.id && !this.leaseExpiryDate) {
          this.leaseExpiryDate = this.defaultLeaseExpiryDate();
        }
        this.loadProductMemory(productId);
      } else if (!checked) {
        this.removeProduct(productId);
      }
    },
    removeProduct(productId) {
      this.form.productIds = this.form.productIds.filter((id) => id !== productId);
      delete this.productMemory[productId];
    },
    async loadProductMemory(productId) {
      this.productMemory[productId] = { loading: true, error: '', files: [] };
      const state = this.productMemory[productId];
      try {
        const response = await fetch(`/api/catalog/products/${encodeURIComponent(productId)}/read-only-memory`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        if (!Array.isArray(data)) throw new Error('The server returned an invalid memory list');
        state.files = data.map((file) => ({
          ...file,
          segments: file.segments.map((segment) => ({
            ...segment,
            value: this.isBaseExpirySegment(productId, file, segment) || this.isBaseSerialSegment(productId, file, segment)
              ? '' : (segment.content ?? ''),
          })),
        }));
      } catch (err) {
        state.error = 'Failed to load read-only memory segments: ' + err.message;
      } finally {
        state.loading = false;
      }
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
    async loadSerialNumber() {
      this.serialLoading = true;
      this.serialError = '';
      try {
        const response = await fetch('/api/product-key-serial-numbers', { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        if (!Array.isArray(data) || data.some((serial) =>
          !Number.isInteger(serial) || serial < 0 || serial > MAX_SERIAL_NUMBER
        )) {
          throw new Error('The server returned an invalid used-serial list.');
        }
        this.usedSerialNumbers = [...new Set(data)];
        const used = new Set(this.usedSerialNumbers);
        let nextSerial = FIRST_SERIAL_NUMBER;
        while (nextSerial <= MAX_SERIAL_NUMBER && used.has(nextSerial)) nextSerial++;
        if (nextSerial > MAX_SERIAL_NUMBER) {
          throw new Error('No unused serial numbers remain above 06000.');
        }
        this.serialNumber = String(nextSerial).padStart(5, '0');
      } catch (err) {
        this.serialError = 'Failed to load the serial number: ' + err.message;
      } finally {
        this.serialLoading = false;
      }
    },
    async loadProducts() {
      this.productsLoading = true;
      this.productError = '';
      try {
        const response = await fetch('/api/entitlement-products');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        if (!data || !/^[1-9]\d*$/.test(String(data.baseProductId)) ||
            !Array.isArray(data.modifications) ||
            !Array.isArray(data.accessProducts) || data.accessProducts.length < 1 ||
            !Array.isArray(data.optionalProducts) ||
            !Array.isArray(data.versionProducts) ||
            !data.leaseExpiryRange || !Number.isSafeInteger(data.leaseExpiryRange.minMonths) ||
            !Number.isSafeInteger(data.leaseExpiryRange.maxMonths) || data.leaseExpiryRange.minMonths < 0 ||
            data.leaseExpiryRange.maxMonths < data.leaseExpiryRange.minMonths || data.leaseExpiryRange.maxMonths > 1200 ||
            data.accessProducts.some((product) => !product || !/^[1-9]\d*$/.test(String(product.id)) ||
              typeof product.label !== 'string' || !data.modifications.some((item) => String(item.productId) === String(product.id))) ||
            data.optionalProducts.some((product) => !product || !/^[1-9]\d*$/.test(String(product.id)) ||
              typeof product.label !== 'string' || typeof product.available !== 'boolean' ||
              (product.available && !data.modifications.some((item) => String(item.productId) === String(product.id)))) ||
            data.versionProducts.some((product) => !product || !/^[1-9]\d*$/.test(String(product.id)) ||
              typeof product.label !== 'string' || typeof product.available !== 'boolean' ||
              (product.available && !data.modifications.some((item) => String(item.productId) === String(product.id)))) ||
            data.modifications.some((product) => !product || !/^[1-9]\d*$/.test(String(product.productId)) ||
              typeof product.productName !== 'string')) {
          throw new Error('The server returned an invalid modification product list');
        }
        this.baseProductId = String(data.baseProductId);
        this.leaseExpiryRange = data.leaseExpiryRange;
        this.products = data.modifications;
        this.accessProducts = data.accessProducts.map((product) => ({ id: String(product.id), label: product.label }));
        this.optionalProducts = data.optionalProducts.map((product) => ({ id: String(product.id), label: product.label, lease: Boolean(product.lease), available: product.available }));
        this.versionProducts = data.versionProducts.map((product) => ({ id: String(product.id), label: product.label, available: product.available }));
        this.defaultVersionLabel = typeof data.defaultVersionLabel === 'string' && data.defaultVersionLabel ? data.defaultVersionLabel : 'Default';
        await this.loadProductMemory(this.baseProductId);
      } catch (err) {
        this.productError = 'Failed to load EMS products: ' + err.message;
      } finally {
        this.productsLoading = false;
      }
    },
    cancel() {
      window.location.assign('/entitlements.html');
    },
    async createEntitlement() {
      this.loading = true;
      this.error = '';
      try {
        if (!this.form.refId1.trim()) throw new Error('Enter an Irricad Order Code (refID 1).');
        const now = new Date();
        const startDate = this.utcToday(now);
        if (this.leaseSelected) LeaseDates.validate(this.leaseExpiryDate, startDate, this.localToday(now), this.leaseExpiryRange);
        const leaseExpiryContent = this.leaseSelected ? this.encodeLeaseExpiryDate(this.leaseExpiryDate) : '';
        const payload = {
          ...this.form,
          productIds: this.form.productIds,
          refId1: this.form.refId1.trim(),
          description: this.form.description.trim(),
          startDate,
          memoryValues: this.memoryProductIds.flatMap((productId) =>
            this.productMemory[productId].files.flatMap((file) =>
              file.kind === 'product'
                ? file.segments.filter((segment) => segment.saot).map((segment) => ({
                  productId,
                  segmentId: segment.id,
                  content: this.isBaseSerialSegment(productId, file, segment)
                    ? this.encodeSerialNumber(this.serialNumber, segment.size)
                    : this.leaseSelected && this.isBaseExpirySegment(productId, file, segment)
                      ? leaseExpiryContent : segment.value,
                }))
                : []
            )
          ),
        };
        const response = await fetch('/api/entitlements', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
          this.form = this.createEmptyForm();
        this.leaseExpiryDate = '';
        this.serialNumber = '';
        this.productMemory = {};
        const serialWarning = data.serialNumberUpdated === false
          ? '&serialWarning=' + encodeURIComponent(data.serialNumberError || 'Unknown serial counter update error')
          : '';
        window.location.assign('/entitlements.html?created=1' + serialWarning);
      } catch (err) {
        this.error = 'Failed to create entitlement: ' + err.message;
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
    this.loadCustomers();
    this.loadProducts();
    this.loadSerialNumber();
  },
}).mount('#app');
