// Prevents the September-2026 incident from repeating: both production tokens
// were committed verbatim to extension-cloudflare/ ("pre-filled defaults",
// commits 078824b → 4f6cced) and stayed retrievable from the public repo's git
// history long after the working tree was cleaned.
//
// Two rules are enforced here:
//
//   1. The extension NEVER ships a literal secret. Values must be the build-time
//      placeholders `__BRIDGE_AUTH_TOKEN__` / `__CLIENT_API_TOKEN__` that
//      scripts/build-extension.py substitutes from Doppler/env.
//   2. No literal `hermes-*` / `gemini-bridge-*` value may appear ANYWHERE in
//      the repo — including inside committed .zip archives, which is how both
//      tokens stayed downloadable from the repo front page long after the
//      source was cleaned (rule 1 alone was structurally blind to this).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const EXT_DIR = path.join(REPO_ROOT, 'extension-cloudflare');

// Matches the production token shapes. 16 hex chars is well below the real
// 32-char length, so this errs toward false positives rather than misses.
const SECRET_RE = /hermes-[a-f0-9]{16,}|gemini-bridge-[a-f0-9]{16,}/gi;

const scan = (text) => [...text.matchAll(SECRET_RE)].map((m) => m[0]);

const git = (...args) =>
  execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const trackedFiles = git('ls-files', '-z').split('\0').filter(Boolean);

// Extension sources, for the placeholder-contract checks below.
const extSources = fs
  .readdirSync(EXT_DIR, { withFileTypes: true })
  .filter((e) => e.isFile() && /\.(js|html|json)$/.test(e.name))
  .map((e) => ({ name: e.name, text: fs.readFileSync(path.join(EXT_DIR, e.name), 'utf8') }));

// ── Minimal ZIP reader (stored + deflate) ──────────────────────────────
// Uses only node:zlib. A committed zip is just a container, so the secret
// scanner has to look inside it or the whole check is theatre.
const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

function readZipMembers(buf) {
  // Locate the End Of Central Directory record (scans back over the comment).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd === -1) return [];

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const members = [];

  for (let i = 0; i < count && buf.readUInt32LE(off) === CEN_SIG; i++) {
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    // Skip the local file header to reach the member's data.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);

    try {
      const data = method === 0 ? raw : zlib.inflateRawSync(raw);
      members.push({ name, data });
    } catch {
      members.push({ name, data: Buffer.alloc(0) }); // unsupported method
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return members;
}

test('repo: no hardcoded token literals (hermes-* / gemini-bridge-*) in tracked files', () => {
  const offenders = [];
  for (const rel of trackedFiles) {
    const abs = path.join(REPO_ROOT, rel);
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; } // deleted but still tracked
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) continue;
    // Skip binaries: a false positive inside a PNG is noise, not a finding.
    if (/\.(png|jpe?g|gif|webp|ico|woff2?|pdf|sqlite3?|wasm|zip|gz|br)$/i.test(rel)) continue;

    const hits = scan(fs.readFileSync(abs, 'utf8'));
    for (const hit of hits) offenders.push(`${rel}: ${hit.slice(0, 12)}…`);
  }
  assert.deepEqual(offenders, [], `literal secrets in tracked files:\n${offenders.join('\n')}`);
});

test('repo: no hardcoded token literals inside zip archives', () => {
  // Deliberately scans zips in the WORKING TREE, not just tracked ones: a
  // tracked-zip-only scan goes permanently vacuous the moment the offending
  // archives are untracked, which is exactly when it needs to keep working.
  const zips = git('ls-files', '-z', '--cached', '--others', '--exclude-standard')
    .split('\0')
    .filter((f) => f.toLowerCase().endsWith('.zip'));

  const offenders = [];
  for (const rel of zips) {
    const abs = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    for (const { name, data } of readZipMembers(fs.readFileSync(abs))) {
      if (name.startsWith('__MACOSX') || name.endsWith('/')) continue;
      for (const hit of scan(data.toString('latin1'))) {
        offenders.push(`${rel} -> ${name}: ${hit.slice(0, 12)}…`);
      }
    }
  }
  assert.deepEqual(offenders, [], `literal secrets inside archives:\n${offenders.join('\n')}`);
});

test('repo: no build artifacts are tracked', () => {
  // release/ and dist/ are gitignored, but zips historically landed at the
  // repo root via Finder "Compress" + `git add`, where nothing objected.
  const artifacts = trackedFiles.filter(
    (f) => /\.(zip|tar|tgz|gz|7z|rar)$/i.test(f) || /(^|\/)(dist|release|build|out)\//.test(f),
  );
  assert.deepEqual(artifacts, [], `build artifacts must not be tracked:\n${artifacts.join('\n')}`);
});

test('extension: default secret/token constants must be build-time placeholders', () => {
  const offenders = [];
  for (const { name, text } of extSources) {
    for (const match of text.matchAll(/(DEFAULT_BRIDGE_SECRET|DEFAULT_CLIENT_API_TOKEN)\s*[:=]\s*["']([^"']*)["']/g)) {
      const [, constant, value] = match;
      if (value !== `__${constant === 'DEFAULT_BRIDGE_SECRET' ? 'BRIDGE_AUTH_TOKEN' : 'CLIENT_API_TOKEN'}__`) {
        offenders.push(`${name}: ${constant} = "${value}"`);
      }
    }
  }
  assert.deepEqual(offenders, [], `non-placeholder defaults:\n${offenders.join('\n')}`);
});

test('extension: the placeholder substitution contract still exists in the build script', () => {
  const build = fs.readFileSync(new URL('../../scripts/build-extension.py', import.meta.url), 'utf8');
  assert.ok(build.includes('__BRIDGE_AUTH_TOKEN__'), 'build script must substitute __BRIDGE_AUTH_TOKEN__');
  assert.ok(build.includes('__CLIENT_API_TOKEN__'), 'build script must substitute __CLIENT_API_TOKEN__');
});

test('worker config files: no secrets in wrangler toml files', () => {
  for (const name of ['../wrangler.toml', '../wrangler.staging.toml']) {
    const text = fs.readFileSync(new URL(name, import.meta.url), 'utf8');
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^(BRIDGE_AUTH_TOKEN|CLIENT_API_TOKEN|GEMINI_API_KEY|CLOUDFLARE_API_TOKEN)\s*=/.test(l));
    assert.deepEqual(lines, [], `${name} must not assign secrets as plain vars:\n${lines.join('\n')}`);
  }
});
