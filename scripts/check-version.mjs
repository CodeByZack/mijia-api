#!/usr/bin/env node
// Fail before publishing if the release tag does not match package.json version.
//
// Publishing without this check publishes whatever version the working tree
// happens to hold under whatever tag the release was cut from, and an npm
// version can never be overwritten - the fix then requires a version bump and
// a second release.
//
// Usage: node scripts/check-version.mjs <tag>
//   <tag>  the GitHub release tag, empty for a manual run with no tag
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const tag = process.argv[2] ?? '';
const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));

if (!tag) {
  console.log('no tag provided - skipping the tag/version check (manual run)');
  process.exit(0);
}
if (tag.replace(/^v/, '') === manifest.version) {
  console.log(`tag ${tag} matches package.json version ${manifest.version}`);
  process.exit(0);
}
console.error(`tag ${tag} does not match package.json version ${manifest.version}`);
console.error('a published npm version cannot be overwritten - fix the tag or the version');
process.exit(1);