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
// Every file this script writes, tracked so the version commit can stage exactly these.
const written = [];

// Only write when the *content* changed, and preserve the file's existing line-ending
// style. Comparing raw text would always differ on a CRLF checkout (freshly serialized
// JSON uses LF), so the script would rewrite every file on every run — dirtying the
// working tree, which `npm version` then refuses to run against.
function writeIfChanged(relPath, before, after) {
  const isCrlf = before.includes('\r\n');
  const normalize = (s) => s.replace(/\r\n/g, '\n');
  if (normalize(before) === normalize(after)) return;

  const out = isCrlf ? normalize(after).replace(/\n/g, '\r\n') : after;
  fs.writeFileSync(path.join(root, relPath), out);
  written.push(relPath);
}

// server.json — both the top-level version and the npm package entry.
const serverRaw = fs.readFileSync(path.join(root, 'server.json'), 'utf8');
const server = JSON.parse(serverRaw);
if (server.version !== version) {
  edits.push(`server.json version: ${server.version} -> ${version}`);
  server.version = version;
}
if (server.packages?.[0] && server.packages[0].version !== version) {
  edits.push(`server.json packages[0].version: ${server.packages[0].version} -> ${version}`);
  server.packages[0].version = version;
}
writeIfChanged('server.json', serverRaw, JSON.stringify(server, null, 2) + '\n');

// packages/prodlint-mcp — version and its dependency range on the scanner.
const mcpRel = 'packages/prodlint-mcp/package.json';
const mcpRaw = fs.readFileSync(path.join(root, mcpRel), 'utf8');
const mcp = JSON.parse(mcpRaw);
if (mcp.version !== version) {
  edits.push(`prodlint-mcp version: ${mcp.version} -> ${version}`);
  mcp.version = version;
}
if (mcp.dependencies.prodlint !== `^${version}`) {
  edits.push(`prodlint-mcp deps.prodlint: ${mcp.dependencies.prodlint} -> ^${version}`);
  mcp.dependencies.prodlint = `^${version}`;
}
writeIfChanged(mcpRel, mcpRaw, JSON.stringify(mcp, null, 2) + '\n');

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
  }
  writeIfChanged(file, raw, updated);
}

console.log(`Syncing everything to v${version}`);
console.log(edits.length ? edits.map((e) => `  ${e}`).join('\n') : '  (already in sync)');

// Under `npm version`, stage everything we touched so it lands in the version commit
// (and therefore the tag). Staging here rather than in package.json's `version` hook
// keeps the file list in one place — a hardcoded `git add` list silently drifts as
// targets are added, which strands edits outside the tag.
if (process.env.npm_lifecycle_event === 'version' && written.length > 0) {
  const { execFileSync } = require('child_process');
  execFileSync('git', ['add', '--', ...written], { cwd: root, stdio: 'inherit' });
  console.log(`\nStaged for the version commit:\n${written.map((f) => `  ${f}`).join('\n')}`);
}
