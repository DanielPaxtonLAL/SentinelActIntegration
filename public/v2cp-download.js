var V2cpDownload = {
  async fetchPackage(protectionKeyId) {
    const response = await fetch(`/api/protection-keys/${encodeURIComponent(protectionKeyId)}/v2cp`, {
      cache: 'no-store',
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    if (typeof data.package !== 'string' || !data.package.trim()) throw new Error('The server returned an invalid V2CP package.');
    return data.package;
  },
  downloadPackage(protectionKeyId, packageXml) {
    const link = document.createElement('a');
    link.href = 'data:application/xml;charset=utf-8,' + encodeURIComponent(packageXml);
    link.download = 'Protection-key-' + protectionKeyId.replace(/[^a-zA-Z0-9_-]/g, '_') + '.v2cp';
    document.body.appendChild(link);
    try {
      link.click();
    } finally {
      link.remove();
    }
  },
};
