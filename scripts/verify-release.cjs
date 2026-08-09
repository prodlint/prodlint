// Pre-publish consistency guard.
//
// npm versions are immutable and the MCP registry cross-checks the *live* npm
// package's mcpName against server.json's name — so a mismatch caught after
// publishing can only be fixed with another version bump. Cheaper to fail here.
//
// Usage: node scripts/verify-release.cjs [tagName]   (e.g. v0.9.5)

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));

const pkg = read('package.json');
const server = read('server.json');
const tag = process.argv[2];

const errors = [];
const checks = [];

function check(label, actual, expected) {
  if (actual === expected) {
    checks.push(`  ok   ${label}: ${actual}`);
  } else {
    checks.push(`  FAIL ${label}: ${actual} (expected ${expected})`);
    errors.push(`${label} is "${actual}", expected "${expected}"`);
  }
}

// A tag is only present in CI; running the script bare just validates the files.
if (tag) {
  const stripped = tag.replace(/^v/, '');
  check('git tag vs package.json version', stripped, pkg.version);
}

check('server.json version', server.version, pkg.version);
check('server.json packages[0].version', server.packages?.[0]?.version, pkg.version);
check('package.json mcpName vs server.json name', pkg.mcpName, server.name);

// The prodlint-mcp launcher must track the scanner exactly. It drifted once before
// (published 0.3.1 depending on prodlint@^0.3.1, which silently pinned every
// `npx -y prodlint-mcp` user to a months-old scanner).
const mcpPkg = read('packages/prodlint-mcp/package.json');
check('prodlint-mcp version', mcpPkg.version, pkg.version);
check('prodlint-mcp dependency on prodlint', mcpPkg.dependencies?.prodlint, `^${pkg.version}`);

// server.json points npx at the launcher, so the registry's npm ownership
// cross-check reads *that* package's mcpName. A mismatch fails publish with a 400.
check('server.json packages[0].identifier', server.packages?.[0]?.identifier, mcpPkg.name);
check('prodlint-mcp mcpName vs server.json name', mcpPkg.mcpName, server.name);

console.log('Release consistency check');
console.log(checks.join('\n'));

if (errors.length > 0) {
  console.error(`\n${errors.length} problem(s) found:`);
  for (const e of errors) console.error(`  - ${e}`);
  console.error('\nFix these before tagging — npm versions cannot be republished.');
  process.exit(1);
}

console.log('\nAll release metadata is consistent.');
