// Walks a project folder, skipping junk, ignored files, binaries and anything that usually
// holds secrets.

import fs from 'node:fs';
import path from 'node:path';

export const MAX_FILE_BYTES = 1_000_000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.city', '.talenscape', 'dist', 'build', '.next', '.cache', 'coverage', '__pycache__', '.venv', 'venv']);
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.gz', '.tar', '.wasm', '.db', '.sqlite', '.woff', '.woff2', '.ttf', '.mp3', '.mp4', '.mov', '.lock']);
const SECRET_NAME = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx)|id_rsa.*|\.dev\.vars)$/i;
const LANGS = { '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js', '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx', '.py': 'py', '.md': 'md' };

export function langOf(rel) {
  return LANGS[path.extname(rel).toLowerCase()] ?? null;
}

// Top folder, except skills/user/<model>/… which belong to that model's district.
export function districtOf(rel) {
  const parts = rel.split('/');
  if (parts[0] === 'skills' && parts[1] === 'user' && parts.length > 3) return parts[2];
  return parts.length > 1 ? parts[0] : '(root)';
}

function ignoreRules(root) {
  const file = path.join(root, '.gitignore');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
    .map((l) => l.replace(/^\/|\/$/g, ''))
    .map((l) => new RegExp('^' + l.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*').replace(/\?/g, '[^/]') + '$'));
}

function isIgnored(rel, rules) {
  const parts = rel.split('/');
  return rules.some((re) => re.test(rel) || parts.some((p) => re.test(p)));
}

export function* walk(root, dir = root, rules = ignoreRules(root)) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (isIgnored(rel, rules)) continue;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && rel !== 'plugin/view') yield* walk(root, full, rules); // plugin/view: a generated copy of app/
    } else if (entry.isFile()) {
      if (SKIP_EXT.has(path.extname(entry.name).toLowerCase()) || SECRET_NAME.test(entry.name)) continue;
      yield { full, rel };
    }
  }
}

export function looksBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}
