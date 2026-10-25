const fs = require('node:fs');
const path = require('node:path');

// This project has one global rule. Keep browser fixtures on the same enforced policy.
const lines = fs.readFileSync(path.join(__dirname, '../_headers'), 'utf8').split(/\r?\n/);
const securityHeaders = Object.fromEntries(lines.filter(line => /^\s+[^#\s]/.test(line)).map(line => {
  const colon = line.indexOf(':');
  if (colon < 1) throw Error('Invalid security header.');
  return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
}));

module.exports = { securityHeaders };
