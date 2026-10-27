#!/usr/bin/env node
// Talenscape skill checker: finds every skills/**/SKILL.md and reports problems.
//
//   node tools/skills.mjs check    list skills, flag bad fields, duplicates and secrets

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { MODELS, TYPES, NAME_RE, SECRET_RE } from './lib/skill-rules.mjs';

export { MODELS };
const SIMILAR_AT = 0.6;
const STOP = new Set('a an and are as at be by for from how in into is it of on or that the this to use used when with your you its any'.split(' '));

// Small reader for the flat `key: value` / `key: [a, b]` block between the --- lines.
export function parseSkill(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: null, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map((v) => v.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      value = value.replace(/^["']|["']$/g, '');
    }
    meta[kv[1]] = value;
  }
  return { meta, body: m[2] };
}

export function findSkills(root) {
  const base = path.join(root, 'skills');
  const out = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('_') || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === 'SKILL.md') out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(base);
  return out.sort();
}

function words(s) {
  return new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => !STOP.has(w) && w.length > 2));
}

export function similarity(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / (A.size + B.size - both);
}

export function checkSkills(root) {
  const skills = [];
  const problems = [];
  const add = (level, file, msg) => problems.push({ level, file, msg });

  for (const file of findSkills(root)) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const { meta, body } = parseSkill(text);
    const parts = file.split('/'); // skills/<area>/.../<folder>/SKILL.md
    const folder = parts[parts.length - 2];
    const area = parts[1];

    if (SECRET_RE.test(text)) add('error', file, 'looks like it contains a key or password. Remove it.');
    if (!meta) { add('error', file, 'missing the --- block of fields at the top.'); continue; }

    if (area === 'catalog') {
      if (parts.length !== 4) add('error', file, 'catalog skills go directly in skills/catalog/<skill-name>/SKILL.md.');
    } else if (area === 'user') {
      if (parts.length !== 5) add('error', file, 'user skills go in skills/user/<model>/<skill-name>/SKILL.md.');
      else if (!MODELS.includes(parts[2])) add('warning', file, `"${parts[2]}" is not a known model folder (${MODELS.join(', ')}).`);
    } else {
      add('error', file, 'skills must be inside skills/catalog/ or skills/user/.');
    }

    if (!meta.name) add('error', file, 'missing "name".');
    else if (!NAME_RE.test(meta.name)) add('error', file, `name "${meta.name}" must be lowercase words joined by hyphens.`);
    else if (meta.name !== folder) add('error', file, `name "${meta.name}" must match its folder "${folder}".`);

    const desc = typeof meta.description === 'string' ? meta.description : '';
    if (!desc) add('error', file, 'missing "description".');
    else if (desc.length < 20 || desc.length > 300) add('warning', file, `description should be 20–300 characters (it is ${desc.length}).`);
    if (!body.trim()) add('warning', file, 'has no instructions below the fields.');
    const type = meta.type ?? 'skill';
    if (!TYPES.includes(type)) add('error', file, `type "${type}" must be one of ${TYPES.join(', ')}.`);
    else if (type !== 'skill' && area !== 'catalog') add('error', file, 'tools and plugins can only be in skills/catalog/ (they can run programs, so they are checked first).');
    if (type === 'plugin' && ![].concat(meta.includes ?? []).length) add('error', file, 'a plugin must list what it includes, e.g. includes: [a-skill, a-tool].');

    skills.push({ file, name: meta.name, description: desc, area, model: area === 'user' ? parts[2] : null, type, includes: [].concat(meta.includes ?? []) });
  }
  const names = new Set(skills.map((s) => s.name));
  for (const s of skills) for (const n of s.includes) if (!names.has(n)) add('error', s.file, `includes "${n}", which is not in the catalog.`);

  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const a = skills[i], b = skills[j];
      if (a.name && a.name === b.name) add('error', b.file, `uses the same name as ${a.file}.`);
      else if (similarity(a.description, b.description) >= SIMILAR_AT) add('warning', b.file, `description is very similar to ${a.file}; it may be a duplicate.`);
    }
  }
  return { skills, problems };
}

export function main([cmd]) {
  if (cmd !== 'check') {
    console.log('Usage: city check-skills');
    process.exit(cmd ? 1 : 0);
  }
  const { skills, problems } = checkSkills(process.cwd());
  console.log(`${skills.length} skill(s) found:`);
  for (const s of skills) console.log(`  ${s.name ?? '(no name)'}  ${s.area}${s.model ? '/' + s.model : ''}`);
  if (!problems.length) { console.log('No problems.'); return; }
  for (const p of problems) console.log(`${p.level.toUpperCase()}: ${p.file} ${p.msg}`);
  if (problems.some((p) => p.level === 'error')) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
