var PendingUpdates = {
  async fetchPackage(file) {
    if (!/\.c2v$/i.test(file.name) || !file.size || file.size > 10 * 1024 * 1024) {
      throw new Error('Choose a non-empty C2V file no larger than 10 MB.');
    }
    const c2v = await file.text();
    const response = await fetch('/api/pending-updates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ c2v }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    if (typeof data.package !== 'string' || !data.package.trim()) throw new Error('The server returned an invalid V2CP package.');
    return data.package;
  },
};
