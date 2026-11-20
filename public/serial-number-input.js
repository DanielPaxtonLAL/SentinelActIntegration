/** Vue input that edits a decimal serial number one digit at a time. */
const SerialNumberInput = {
  props: {
    modelValue: { type: String, required: true },
    maxDigits: { type: Number, required: true },
    disabled: { type: Boolean, default: false },
    invalid: { type: Boolean, default: false },
  },
  emits: ['update:modelValue'],
  data() {
    return { pasteError: '', atEnd: false };
  },
  computed: {
    digitCount() {
      return Math.max(5, this.maxDigits, this.modelValue.length);
    },
  },
  methods: {
    setPasteError(message) {
      this.pasteError = message;
      this.$refs.digits[0].setCustomValidity(message);
    },
    focusDigit(index) {
      this.$nextTick(() => this.$refs.digits[Math.max(0, Math.min(index, this.digitCount - 1))].focus());
    },
    onFocus(event, index) {
      this.atEnd = false;
      if (index > this.modelValue.length) {
        this.focusDigit(this.modelValue.length);
      } else {
        event.target.select();
      }
    },
    setDigit(index, digit) {
      this.setPasteError('');
      index = Math.min(index, this.modelValue.length);
      this.$emit('update:modelValue', this.modelValue.slice(0, index) + digit + this.modelValue.slice(index + 1));
      this.$nextTick(() => {
        this.$refs.digits[Math.min(index + 1, this.digitCount - 1)].focus();
        this.atEnd = index + 1 >= this.digitCount;
      });
    },
    onInput(event, index) {
      const digit = event.target.value.replace(/\D/g, '').slice(-1);
      event.target.value = this.modelValue[index] || '';
      if (digit && this.atEnd) this.setPasteError(`Enter no more than ${this.digitCount} digits.`);
      else if (digit) this.setDigit(index, digit);
      else if (!event.data && event.inputType?.startsWith('delete')) {
        this.atEnd = false;
        this.setPasteError('');
        this.$emit('update:modelValue', this.modelValue.slice(0, index) + this.modelValue.slice(index + 1));
        this.focusDigit(index);
      }
    },
    onKeydown(event, index) {
      if (/^\d$/.test(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        if (this.atEnd) this.setPasteError(`Enter no more than ${this.digitCount} digits.`);
        else this.setDigit(index, event.key);
      } else if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault();
        this.atEnd = false;
        const target = event.key === 'Backspace' && index >= this.modelValue.length && index > 0 ? index - 1 : index;
        this.setPasteError('');
        this.$emit('update:modelValue', this.modelValue.slice(0, target) + this.modelValue.slice(target + 1));
        this.focusDigit(target);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        this.atEnd = false;
        this.focusDigit(Math.min(this.modelValue.length, index + (event.key === 'ArrowLeft' ? -1 : 1)));
      }
    },
    onPaste(event, index) {
      event.preventDefault();
      const text = event.clipboardData.getData('text').trim();
      if (!/^[\d,\s]+$/.test(text)) {
        this.setPasteError('Paste a serial number containing digits only.');
        return;
      }
      const digits = text.replace(/[,\s]/g, '');
      index = Math.min(index, this.modelValue.length);
      if (!digits || index + digits.length > this.digitCount) {
        this.setPasteError(`Enter no more than ${this.digitCount} digits.`);
        return;
      }
      this.setPasteError('');
      this.$emit('update:modelValue', this.modelValue.slice(0, index) + digits + this.modelValue.slice(index + digits.length));
      this.focusDigit(index + digits.length);
      this.atEnd = false;
    },
  },
  template: `
    <div class="serial-number-field" role="group" aria-labelledby="serial-label" :aria-describedby="invalid ? 'serial-error' : (pasteError ? 'serial-paste-error' : 'serial-hint')">
      <span id="serial-label" class="serial-number-label">Serial number (decimal)</span>
      <div class="serial-number-digits">
        <input v-for="index in digitCount" :key="index" ref="digits"
          :value="modelValue[index - 1] || ''" type="text" inputmode="numeric" pattern="[0-9]" maxlength="1"
          :aria-label="'Serial number digit ' + index + ' of ' + digitCount" :aria-invalid="invalid || Boolean(pasteError)"
          :required="index === 1" :disabled="disabled" autocomplete="off"
          @pointerdown="atEnd = false" @focus="onFocus($event, index - 1)" @input="onInput($event, index - 1)"
          @keydown="onKeydown($event, index - 1)" @paste="onPaste($event, index - 1)">
      </div>
      <span id="serial-hint" class="form-hint">Enter digits from left to right.</span>
      <span v-if="pasteError" id="serial-paste-error" class="form-error" role="alert">{{ pasteError }}</span>
      <slot></slot>
    </div>
  `,
};
