const fs = require('fs');
const path = require('path');

const INCLUDE_PATTERN = /^([ \t]*)<!-- include: ([a-z-]+) -->[ \t]*$/gm;
const CURRENT_AREA = {
  '/': 'customers',
  '/index.html': 'customers',
  '/entitlements.html': 'entitlements',
  '/create-entitlement-form.html': 'entitlements',
};

function renderPage(html, partialsDir, requestPath) {
  const area = CURRENT_AREA[requestPath];
  const current = (name) => (name === area ? ' aria-current="page"' : '');
  return html.replace(INCLUDE_PATTERN, (match, indent, name) => {
    const partial = fs.readFileSync(path.join(partialsDir, `${name}.html`), 'utf8')
      .replace(/\r?\n$/, '')
      .replace(/{{(entitlements|customers)Current}}/g, (token, key) => current(key));
    return partial.split(/\r?\n/).map((line) => (line ? indent + line : line)).join('\n');
  });
}

function pageIncludes(publicDir, partialsDir) {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const requestPath = req.path === '/' ? '/index.html' : req.path;
    if (!requestPath.toLowerCase().endsWith('.html')) return next();
    const file = path.join(publicDir, path.normalize(decodeURIComponent(requestPath)));
    if (!file.startsWith(publicDir + path.sep)) return next();
    fs.readFile(file, 'utf8', (err, html) => {
      if (err) return next();
      res.type('html').send(renderPage(html, partialsDir, req.path === '/' ? '/' : requestPath));
    });
  };
}

module.exports = { pageIncludes, renderPage };
