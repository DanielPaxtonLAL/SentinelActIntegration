const fs = require('fs');

/**
 * Load simple KEY=VALUE entries without replacing process-provided values.
 * Matching single or double quotes around a complete value are removed.
 * An unquoted value may be followed by a whitespace-separated comment.
 * @param {string} file Path to the optional environment file.
 * @param {Record<string, string | undefined>} env Destination environment.
 * @param {object} [fileSystem] File operations, injectable for isolated tests.
 */
function loadEnvironmentFile(file, env, fileSystem = fs) {
  if (!fileSystem.existsSync(file)) return;
  for (const line of fileSystem.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([\w.]+)\s*=\s*(.*?)\s*$/);
    if (!match || line.trim().startsWith('#')) continue;
    const value = match[2];
    const quoted = value.match(/^(['"])(.*?)\1(?:\s+#.*)?$/);
    env[match[1]] ??= quoted ? quoted[2] : value.replace(/\s+#.*$/, '');
  }
}

module.exports = { loadEnvironmentFile };
