// The browser bundle expects window even though this code runs in a worker.
self.window = self;
importScripts('/vendor/forge.min.js');

self.onmessage = ({ data }) => {
  try {
    const raw = (bytes) => forge.util.binary.raw.encode(bytes);
    const key = forge.pkcs5.pbkdf2(raw(data.password), raw(data.salt), 600000, 32, 'sha256');
    const decrypting = data.operation === 'decrypt';
    const input = raw(data.input);
    const cipher = decrypting
      ? forge.cipher.createDecipher('AES-GCM', key)
      : forge.cipher.createCipher('AES-GCM', key);
    const options = { iv: raw(data.iv), additionalData: raw(data.username), tagLength: 128 };
    if (decrypting) options.tag = input.slice(-16);
    cipher.start(options);
    cipher.update(forge.util.createBuffer(decrypting ? input.slice(0, -16) : input));
    if (!cipher.finish()) throw new Error('Authentication failed.');
    const result = cipher.output.getBytes() + (decrypting ? '' : cipher.mode.tag.getBytes());
    self.postMessage({ result: forge.util.binary.raw.decode(result) });
  } catch (err) {
    self.postMessage({ error: 'Could not process encrypted credentials.' });
  }
};
