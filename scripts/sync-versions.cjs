// Propagates the root package.json version into every other file that hardcodes it.
// Run after `npm version <bump>`; `npm run verify:release` then confirms the result.
//
// Usage: node scripts/sync-versions.cjs

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const rootPkgPath = path.join(root, 'package.json');
const version = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8')).version;

const edits = [];

// server.json — both the top-level version and the npm package entry.
const serverPath = path.join(root, 'server.json');
const server = JSON.parse(fs.readFileSync(serverPath, 'utf8'));
if (server.version !== version) {
  edits.push(`server.json version: ${server.version} -> ${version}`);
  server.version = version;
}
if (server.packages?.[0] && server.packages[0].version !== version) {
  edits.push(`server.json packages[0].version: ${server.packages[0].version} -> ${version}`);
  server.packages[0].version = version;
}
fs.writeFileSync(serverPath, JSON.stringify(server, null, 2) + '\n');

// packages/prodlint-mcp — version and its dependency range on the scanner.
const mcpPath = path.join(root, 'packages', 'prodlint-mcp', 'package.json');
const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
if (mcp.version !== version) {
  edits.push(`prodlint-mcp version: ${mcp.version} -> ${version}`);
  mcp.version = version;
}
if (mcp.dependencies.prodlint !== `^${version}`) {
  edits.push(`prodlint-mcp deps.prodlint: ${mcp.dependencies.prodlint} -> ^${version}`);
  mcp.dependencies.prodlint = `^${version}`;
}
fs.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + '\n');

// Plain-text version strings. Each pattern must match exactly once — if a file is
// restructured so the anchor moves, fail loudly rather than silently skipping it.
const SEMVER = /\d+\.\d+\.\d+/;
const textTargets = [
  {
    file: 'README.md',
    label: 'README sample output',
    pattern: /^\s*prodlint v\d+\.\d+\.\d+$/m,
  },
  {
    file: 'tests/reporter.test.ts',
    label: 'reporter test fixture',
    pattern: /^\s*version: '\d+\.\d+\.\d+',$/m,
  },
];

for (const { file, label, pattern } of textTargets) {
  const full = path.join(root, file);
  const raw = fs.readFileSync(full, 'utf8');
  const matches = raw.match(new RegExp(pattern.source, pattern.flags.replace('m', 'gm')));

  if (!matches || matches.length !== 1) {
    console.error(
      `\n${file}: expected exactly 1 version string for "${label}", found ${matches ? matches.length : 0}.`
    );
    console.error('The anchor has moved — update scripts/sync-versions.cjs.');
    process.exit(1);
  }

  // Substitute inside the matched line rather than reassembling from capture groups —
  // replace() passes the match offset where an unused group would be, so an arity
  // mismatch silently appends it to the version.
  const before = matches[0];
  const updated = raw.replace(pattern, (m) => m.replace(SEMVER, version));
  if (updated !== raw) {
    edits.push(`${label}: ${before.trim()} -> ${before.trim().replace(SEMVER, version)}`);
    fs.writeFileSync(full, updated);
  }
}

console.log(`Syncing everything to v${version}`);
console.log(edits.length ? edits.map((e) => `  ${e}`).join('\n') : '  (already in sync)');
