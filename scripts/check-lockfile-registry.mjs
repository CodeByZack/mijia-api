#!/usr/bin/env node
// Fail before `npm ci` if package-lock.json pins any package to a non-npm registry.
//
// Why this exists: a developer whose ~/.npmrc points at a mirror (for example
// registry.npmmirror.com) bakes the mirror URLs into every `resolved` field of the
// lockfile. npm ci on the public registry then refuses each one with EALLOWREMOTE,
// and the error names a tarball URL - never the cause - so the publish fails at the
// first step for the wrong reason.
//
// This check runs before npm ci and reports the offending hosts plus the fix.
//
// Usage: node scripts/check-lockfile-registry.mjs [package-lock.json]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const lockPath = resolve(process.cwd(), process.argv[2] ?? 'package-lock.json');
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));

const allowed = 'https://registry.npmjs.org';
const suspects = new Map();
for (const [spec, entry] of Object.entries(lock?.packages ?? {})) {
  const resolved = entry?.resolved;
  if (typeof resolved !== 'string') continue;
  if (resolved.startsWith(allowed)) continue;
  if (resolved.startsWith('git+')) continue;  // git deps legitimately resolve to a git host
  const host = new URL(resolved).host;
  suspects.set(host, (suspects.get(host) ?? 0) + 1);
}

if (suspects.size === 0) {
  console.log(`${lockPath} resolves every package from registry.npmjs.org`);
  process.exit(0);
}

console.error(`${lockPath} pins ${[...suspects.values()].reduce((a, b) => a + b, 0)} packages to a non-npm registry:`);
for (const [host, count] of [...suspects].sort()) console.error(`  ${count} x ${host}`);
console.error('');
console.error('npm ci will refuse each of these with EALLOWREMOTE.');
console.error('Regenerate the lockfile against the public registry before publishing:');
console.error('  npm install --package-lock-only --registry=https://registry.npmjs.org');
console.error('Then confirm with: npm ci');
process.exit(1);