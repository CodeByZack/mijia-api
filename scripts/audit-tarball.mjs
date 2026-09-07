#!/usr/bin/env node
// Audit the PACKED contents of this package, not the working tree.
//
// The point of auditing the tarball rather than package.json is that npm may
// keep a manifest field while omitting the file it points at. For this package the
// sharper risk is the opposite direction: dist/ is gitignored and built in CI, so a
// skipped or failed build packs a tarball whose `main`/`exports` all point at files
// that were never created. Every consumer would then get a broken package, and npm
// would never accept the fix as a republish of the same version.
//
// Usage:
//   npm pack --silent | tail -n1 > .audit/tarball.txt
//   tar -xzf "$(cat .audit/tarball.txt)" -C .audit
//   node scripts/audit-tarball.mjs .audit/package "$(cat .audit/tarball.txt)" [tag]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

const [, , pkgDirArg, tarball, expected] = process.argv;

// Resolve both paths once, so the script works from any CWD.
const pkgDir = pkgDirArg ? (isAbsolute(pkgDirArg) ? pkgDirArg : resolve(process.cwd(), pkgDirArg)) : '';
const tarballPath = tarball ? (isAbsolute(tarball) ? tarball : resolve(process.cwd(), tarball)) : '';

let failures = 0;
function ok(msg) { console.log('  ok    ' + msg); }
function fail(msg) { console.error('  FAIL  ' + msg); failures++; }
function warn(msg) { console.log('  warn  ' + msg); }

if (!pkgDir || !existsSync(pkgDir)) fail('package directory not found: ' + pkgDirArg);
const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

console.log('\n1. tarball');
const packedFiles = listFiles(pkgDir).map((path) => rel(path, pkgDir));
if (tarballPath) {
  if (!existsSync(tarballPath)) fail('tarball not found: ' + tarballPath);
  else {
    const size = statSync(tarballPath).size;
    if (size === 0) fail('tarball is empty');
    else ok(`${basename(tarballPath)} (${size} bytes, ${packedFiles.length} files)`);
  }
} else warn('tarball path not provided, checking the extracted directory only');

console.log('\n2. dist/ ships');
// This package builds with tsup: dual ESM/CJS plus a d.ts for each format.
// They are generated at publish time from the exact source at the tagged commit,
// which is why a missing one is a build failure and not a packaging nit.
const requiredDist = ['index.js', 'index.cjs', 'index.d.ts', 'index.d.cts'];
for (const f of requiredDist) {
  const p = join(pkgDir, 'dist', f);
  if (!existsSync(p)) fail('dist/' + f + ' is missing from the tarball');
  else {
    const b = readFileSync(p);
    if (b.length === 0) fail('dist/' + f + ' is empty');
    else ok(`dist/${f} (${b.length} bytes)`);
  }
}
const sourcemaps = ['index.js.map', 'index.cjs.map'].filter((f) => existsSync(join(pkgDir, 'dist', f)));
if (sourcemaps.length === 2) ok('both source maps ship');
else warn('expected index.js.map and index.cjs.map in dist/ (found ' + sourcemaps.join(', ') + ')');

console.log('\n3. dist/ is real, not a placeholder');
// A skipped build can still leave a stub. Check that the ESM entry actually exports
// the public API and that the declaration file declares it.
const esmPath = join(pkgDir, 'dist', 'index.js');
const dtsPath = join(pkgDir, 'dist', 'index.d.ts');
if (existsSync(esmPath)) {
  const esm = readFileSync(esmPath, 'utf8');
  const runtimeExports = ['MijiaAPI', 'MijiaApiClient', 'AuthStore', 'MijiaDevice', 'RC4'];
  const missing = runtimeExports.filter((n) => !esm.includes(n));
  if (missing.length) fail('dist/index.js is missing runtime exports: ' + missing.join(', '));
  else ok('dist/index.js exports ' + runtimeExports.length + ' expected runtime names');
}
if (existsSync(dtsPath)) {
  const dts = readFileSync(dtsPath, 'utf8');
  const typeExports = ['MijiaAPI', 'DeviceInfo', 'DeviceProperty', 'PropResult', 'Scene', 'LoginOptions'];
  const missing = typeExports.filter((n) => !dts.includes(n));
  if (missing.length) fail('dist/index.d.ts is missing type exports: ' + missing.join(', '));
  else ok('dist/index.d.ts declares ' + typeExports.length + ' expected type names');
}

console.log('\n4. entry points resolve to packed files');
function resolveEntry(entry) {
  if (typeof entry === 'string') return [entry];
  const out = [];
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'types' || key === 'default') out.push(...resolveEntry(value));
  }
  return out;
}
const entries = [];
if (manifest.main) entries.push(['main', manifest.main]);
if (manifest.module) entries.push(['module', manifest.module]);
if (manifest.types) entries.push(['types', manifest.types]);
if (manifest.exports) {
  for (const [key, value] of Object.entries(manifest.exports)) {
    if (key === './package.json') continue;
    for (const file of resolveEntry(value)) entries.push(['exports[' + key + ']', file]);
  }
}
for (const [label, file] of entries) {
  const rel = file.replace(/^\.[\/\\]/, '');
  if (!existsSync(join(pkgDir, rel))) fail(label + ' -> ' + rel + ' is not in the tarball');
  else ok(`${label} -> ${rel}`);
}
if (!entries.length) fail('no entry points declared');

console.log('\n5. files field entries ship');
const files = manifest.files ?? [];
for (const f of files) {
  if (!existsSync(join(pkgDir, f))) fail('files entry not packed: ' + f);
  else ok(f);
}
if (!files.length) warn('no files field - npm packs the whole directory');

console.log('\n6. license');
const license = manifest.license ?? '';
if (!license) fail('no license field');
else if (!/^(MIT|Apache-2.0|BSD-2-Clause|BSD-3-Clause|ISC|Unlicense)$/.test(license)) fail('license ' + license + ' is not npm-friendly');
else ok(license);
if (!existsSync(join(pkgDir, 'LICENSE'))) fail('LICENSE file is missing from the tarball');
else ok('LICENSE file ships');

console.log('\n7. documentation');
if (existsSync(join(pkgDir, 'README.md'))) ok('README.md ships');
else fail('README.md is missing - consumers get no usage docs');

console.log('\n8. engines');
if (manifest.engines?.node) ok('engines.node ' + manifest.engines.node);
else warn('no engines.node - consumers get no runtime requirement');

console.log('\n9. repository');
if (manifest.repository?.url) ok(manifest.repository.url);
else fail('no repository field');

console.log('\n10. version');
if (expected) {
  const normalized = expected.replace(/^v/, '');
  if (normalized === manifest.version) ok(`version ${manifest.version} matches the release tag ${expected}`);
  else fail(`version ${manifest.version} does not match the release tag ${expected} - refusing to publish the wrong version`);
} else ok(`version ${manifest.version}`);

console.log('\n11. nothing private leaked');
// src/, test/ and scripts/ stay out of the tarball on purpose: users need the built
// output, not the tree, and shipping internals inflates every install.
const packed = readdirSync(pkgDir);
const leaks = packed.filter((n) => ['src', 'test', 'scripts', 'examples', '.github', '.git'].includes(n));
if (leaks.length) fail('unexpected directories in the tarball: ' + leaks.join(', '));
else ok('only packaged files present: ' + packed.join(', '));

if (failures > 0) {
  console.error('\n' + failures + ' audit failure(s)');
  process.exit(1);
}
console.log('\nall checks passed');

function rel(path, root) {
  return path.slice(root.length + 1);
}

function listFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}