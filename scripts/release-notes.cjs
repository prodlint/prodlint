// CHANGELOG.md's release sections. `npm version` moves the [Unreleased] entries under the new
// version (sync-versions.cjs), and that section becomes the GitHub Release's body (release.yml).
//
// Usage: node scripts/release-notes.cjs <version>   (e.g. 0.10.6, or Unreleased)
// Prints the section without its heading; exits 1 if it's missing or empty.

const fs = require('fs');
const path = require('path');

/** A section's text without its heading; empty when the version has no section, or nothing in it */
function releaseNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) return '';
  const end = lines.findIndex((line, i) => i > start && line.startsWith('## ['));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();
}

/** The changelog with the [Unreleased] entries under a new heading for this version */
function moveUnreleased(changelog, version, date) {
  return changelog.replace(/^## \[Unreleased\]$/m, () => `## [Unreleased]\n\n## [${version}] - ${date}`);
}

if (require.main === module) {
  const version = process.argv[2];
  if (!version) {
    console.error('Usage: release-notes.cjs <version>');
    process.exit(2);
  }
  const changelog = fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  const notes = releaseNotes(changelog, version);
  if (!notes) {
    console.error(`CHANGELOG.md has nothing under "## [${version}]".`);
    process.exit(1);
  }
  console.log(notes);
}

module.exports = { moveUnreleased, releaseNotes };
