(function (root) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const iterations = 600000;

  function cryptoApi() {
    if (!root.crypto?.getRandomValues) throw new Error('This browser does not support secure random numbers.');
    return root.crypto;
  }

  function runWorker(operation, password, salt, iv, username, input) {
    if (!root.Worker) throw new Error('This browser does not support credential encryption.');
    return new Promise((resolve, reject) => {
      const worker = new root.Worker('/login-crypto-worker.js');
      worker.onmessage = ({ data }) => {
        worker.terminate();
        if (data.error) reject(new Error(data.error));
        else resolve(data.result);
      };
      worker.onerror = () => {
        worker.terminate();
        reject(new Error('Could not start credential encryption.'));
      };
      worker.postMessage({ operation, password: encoder.encode(password), salt, iv, username: encoder.encode(username), input });
    });
  }

  function encode(bytes) {
    return btoa(String.fromCharCode(...new Uint8Array(bytes)));
  }

  function decode(value) {
    if (typeof value !== 'string') throw new Error('Invalid saved credentials.');
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  }

  async function keyFor(password, salt) {
    const subtle = cryptoApi().subtle;
    const material = await subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
  }

  async function encrypt(emsUsername, emsPassword, credentials) {
    const crypto = cryptoApi();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const input = encoder.encode(JSON.stringify(credentials));
    const ciphertext = crypto.subtle
      ? await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(emsUsername) },
        await keyFor(emsPassword, salt), input
      )
      : await runWorker('encrypt', emsPassword, salt, iv, emsUsername, input);
    return JSON.stringify({ version: 1, salt: encode(salt), iv: encode(iv), ciphertext: encode(ciphertext) });
  }

  async function decrypt(emsUsername, emsPassword, saved) {
    const record = JSON.parse(saved);
    if (!record || record.version !== 1) throw new Error('Invalid saved credentials.');
    const salt = decode(record.salt);
    const iv = decode(record.iv);
    if (salt.length !== 16 || iv.length !== 12) throw new Error('Invalid saved credentials.');
    const crypto = cryptoApi();
    const input = decode(record.ciphertext);
    const plaintext = crypto.subtle
      ? await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(emsUsername) },
        await keyFor(emsPassword, salt), input
      )
      : await runWorker('decrypt', emsPassword, salt, iv, emsUsername, input);
    const credentials = JSON.parse(decoder.decode(plaintext));
    if (!credentials || typeof credentials.username !== 'string' || !credentials.username.trim() ||
        typeof credentials.password !== 'string' || !credentials.password) {
      throw new Error('Invalid saved credentials.');
    }
    return credentials;
  }

  root.loginCredentials = { encrypt, decrypt };
})(globalThis);
