// Savings meter: counts tokens Talenscape kept out of the AI's context this session.
// Only concrete savings are counted (trimmed command output, outlines instead of big files),
// as estimates: full size minus what the AI actually got.

import fs from 'node:fs';
import path from 'node:path';

const file = (root) => path.join(root, '.city', 'savings.json');

export function readSavings(root) {
  try { return JSON.parse(fs.readFileSync(file(root), 'utf8')); } catch { return { current: {}, last: {} }; }
}

export function addSaving(root, kind, fullTokens, usedTokens) {
  const saved = Math.max(0, fullTokens - usedTokens);
  if (!saved) return;
  const s = readSavings(root);
  s.current[kind] = (s.current[kind] ?? 0) + saved;
  try {
    fs.mkdirSync(path.dirname(file(root)), { recursive: true });
    fs.writeFileSync(file(root), JSON.stringify(s));
  } catch { /* the meter must never get in the way */ }
}

// Short answers (snip L0) are counted honestly: a short answer saves the body it didn't send, but if
// the AI then asks for that body anyway, the saving is taken back and the wasted short answer is
// charged, and the follow-up is counted, so the meter shows whether short-first pays off.
export function noteSnip(root, name, level, fullTokens, usedTokens) {
  const s = readSavings(root);
  s.snips ??= {}; s.current ??= {}; s.counts ??= { short: 0, expanded: 0 };
  const kind = 'short answers';
  if (level === 'sig') {
    s.snips[name] = { full: fullTokens, used: usedTokens };
    s.counts.short++;
    s.current[kind] = (s.current[kind] ?? 0) + Math.max(0, fullTokens - usedTokens);
  } else if (s.snips[name]) {
    const { full, used } = s.snips[name];
    delete s.snips[name];
    s.counts.expanded++;
    s.current[kind] = (s.current[kind] ?? 0) - Math.max(0, full - used) - used; // net: the short answer was extra
  } else return;
  try { fs.mkdirSync(path.dirname(file(root)), { recursive: true }); fs.writeFileSync(file(root), JSON.stringify(s)); } catch { /* never in the way */ }
}

// Called once at session start: this session's count becomes "last session", and is kept in the
// history (one entry per session, newest last, up to a year's worth) for the app's savings page.
export function rotateSavings(root) {
  const s = readSavings(root);
  const done = Object.keys(s.current ?? {}).length ? s.current : null;
  const history = [...(s.history ?? []), ...(done ? [{ at: s.startedAt ?? new Date().toISOString(), totals: done, ...(s.counts ? { counts: s.counts } : {}) }] : [])].slice(-500);
  const next = { current: {}, last: done ?? s.last ?? {}, history, startedAt: new Date().toISOString(), counts: { short: 0, expanded: 0 }, countsLast: s.counts ?? null };
  try {
    fs.mkdirSync(path.dirname(file(root)), { recursive: true });
    fs.writeFileSync(file(root), JSON.stringify(next));
  } catch { /* ignore */ }
  return next.last;
}

export function savingsLine(totals) {
  const sum = Object.values(totals ?? {}).reduce((a, b) => a + b, 0);
  if (!sum) return null;
  const parts = Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toLocaleString('en-US')}`);
  return `SAVED last session: ~${sum.toLocaleString('en-US')} tokens (${parts.join(', ')})`;
}
