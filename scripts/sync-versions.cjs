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

console.log(`Syncing everything to v${version}`);
console.log(edits.length ? edits.map((e) => `  ${e}`).join('\n') : '  (already in sync)');
