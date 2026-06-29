const fs = require('fs');
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const packages = lock.packages || {};

// Check for non-npmjs registry URLs
console.log('=== PACKAGES WITH NON-NPMJS REGISTRY ===');
const unusual = [];
for (const [name, info] of Object.entries(packages)) {
  if (info.resolved && !info.resolved.startsWith('https://registry.npmjs.org/')) {
    unusual.push({ name, resolved: info.resolved });
  }
}
console.log(unusual.length > 0 ? JSON.stringify(unusual, null, 2) : 'NONE - all from registry.npmjs.org');

// Check for packages without integrity hashes
console.log('\n=== PACKAGES WITHOUT INTEGRITY HASH ===');
const noIntegrity = [];
for (const [name, info] of Object.entries(packages)) {
  if (name === '') continue;
  if (!info.integrity && !info.link) {
    noIntegrity.push(name);
  }
}
console.log(noIntegrity.length > 0 ? noIntegrity.join('\n') : 'NONE - all have integrity hashes');

// Check lockfile version
console.log('\n=== LOCKFILE VERSION ===');
console.log('lockfileVersion:', lock.lockfileVersion);

// Count total packages
console.log('\n=== TOTAL PACKAGES IN LOCKFILE ===');
const count = Object.keys(packages).filter(k => k !== '').length;
console.log(count);

// Check for deprecated packages
console.log('\n=== DEPRECATED PACKAGES ===');
const deprecated = [];
for (const [name, info] of Object.entries(packages)) {
  if (info.deprecated) {
    deprecated.push({ name, deprecated: info.deprecated });
  }
}
console.log(deprecated.length > 0 ? JSON.stringify(deprecated, null, 2) : 'NONE');
