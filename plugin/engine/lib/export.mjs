// `city export <plugin>`: a plugin made on the workbench, as real installable packages, in
// exports/<plugin>/ in this project:
//   claude/    a Claude Code plugin (manifest, the recipe skill, a /command, a helper agent, and the
//              skills its steps use), plus a marketplace file so it installs with one line
//   gemini/    a Gemini CLI extension (manifest, GEMINI.md, the skills, a command)
//   skills/    the plain Agent Skills folders (SKILL.md), for Codex / ChatGPT, Grok Build, Muse Code
//              and the other tools that read the standard
//   README.md  how to install each
// Steps that still need building travel as instructions only (the AI asks before building them).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';
import path from 'node:path';
import { parseSkill, findSkills } from '../skills.mjs';

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// The steps a workbench recipe carries on its first line (the same mark as app/recipe.js).
const readRecipe = (body) => { const m = String(body).match(/^\s*<!-- talenscape-plugin: (\{.*\}) -->/); try { return m ? JSON.parse(m[1]).steps.map((x) => ({ name: x.n, missing: !!x.m })) : null; } catch { return null; } };

// A skill file in the project by name: its own folders first, then any skills/ tree.
function skillFile(root, name) {
  for (const d of ['.claude', '.agents', '.grok', '.gemini']) {
    const f = path.join(root, d, 'skills', name, 'SKILL.md');
    if (fs.existsSync(f)) return f;
  }
  const hit = findSkills(root).find((f) => parseSkill(fs.readFileSync(path.join(root, f), 'utf8')).meta?.name === name);
  return hit ? path.join(root, hit) : null;
}

// The standard form of a skill: only the fields every tool reads (name, description), then the text.
function standard(name, meta, body) {
  const when = [].concat(meta.triggers ?? []).join(', ');
  let description = String(meta.description ?? name).replace(/\s+/g, ' ').trim();
  if (when && !description.includes(when)) description = `${description} Use when: ${when}.`;
  description = description.slice(0, 1024).replace(/"/g, "'");
  return `---\nname: ${name}\ndescription: "${description}"\n---\n\n${body.replace(/^\s*<!-- talenscape-plugin: .* -->\n/, '').trim()}\n`;
}

// A square 512 px PNG icon drawn by code: the plugin's stadium seen from above (rings of stands round a
// green field), in a colour picked from its name. No image files, nothing to license.
function icon(name) {
  const W = 512, h = [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const tones = [[60, 224, 240], [255, 95, 209], [127, 227, 107], [255, 154, 46], [90, 140, 255], [246, 201, 14]], seat = tones[h % tones.length];
  const raw = Buffer.alloc((W * 3 + 1) * W);
  for (let y = 0; y < W; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      const dx = (x - W / 2) / 200, dy = (y - W / 2) / 150, r = Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
      let c = [20, 18, 22]; // ink
      if (r < 0.55) c = [70, 150, 80]; // the field
      else if (r < 1.18) c = Math.floor(((ang + Math.PI) / (2 * Math.PI)) * 8) % 2 ? [240, 234, 220] : seat; // sections
      else if (r > 1.25) c = [246, 239, 223]; // paper
      if (Math.abs(r - 0.55) < 0.025 || Math.abs(r - 1.18) < 0.03 || (r > 0.55 && r < 1.18 && Math.abs((((ang + Math.PI) / (2 * Math.PI)) * 8) % 1) < 0.012)) c = [20, 18, 22];
      raw.set(c, y * (W * 3 + 1) + 1 + x * 3);
    }
  }
  const crc = (buf) => { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), sum = Buffer.alloc(4); len.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, sum]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Who made it: the project's git name, if it has one.
function author(root) { try { return execFileSync('git', ['config', 'user.name'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; } }

const MIT = (year, who) => `MIT License\n\nCopyright (c) ${year} ${who}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\nof this software and associated documentation files (the "Software"), to deal\nin the Software without restriction, including without limitation the rights\nto use, copy, modify, merge, publish, distribute, sublicense, and/or sell\ncopies of the Software, and to permit persons to whom the Software is\nfurnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all\ncopies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR\nIMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,\nFITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE\nAUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER\nLIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,\nOUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE\nSOFTWARE.\n`;

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

export function exportPlugin(root, name, { version = '1.0.0' } = {}) {
  if (!NAME.test(name ?? '')) return { error: 'Give the plugin\'s name, like weekly-report.' };
  const main = skillFile(root, name);
  if (!main) return { error: `No plugin called ${name} in this project yet: make it on the workbench first.` };
  const { meta, body } = parseSkill(fs.readFileSync(main, 'utf8'));
  const steps = readRecipe(body);
  if (!meta || !steps) return { error: `${name} isn't a workbench plugin (it has no steps).` };
  const skills = [{ name, text: standard(name, meta, body) }];
  const notFound = [];
  for (const s of steps) {
    if (s.missing || skills.some((k) => k.name === s.name)) continue;
    const f = skillFile(root, s.name);
    if (!f) { notFound.push(s.name); continue; } // a tool or a catalog item that isn't a file here
    const p = parseSkill(fs.readFileSync(f, 'utf8'));
    skills.push({ name: s.name, text: standard(s.name, p.meta ?? {}, p.body) });
  }
  const description = String(meta.description ?? '').replace(/\s+/g, ' ').trim();
  const helper = body.match(/## Helper\n\nBefore handing over the result, review it as (.+?), and fix/)?.[1];
  const out = path.join(root, 'exports', name);
  fs.rmSync(out, { recursive: true, force: true });

  // Claude Code plugin.
  const c = path.join(out, 'claude');
  const who = author(root) ?? 'The author';
  write(path.join(c, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version, description, author: { name: who }, license: 'MIT', icon: '.claude-plugin/icon.png', keywords: ['talenscape', 'workbench'] }, null, 2) + '\n');
  write(path.join(c, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: `${name}-marketplace`, owner: { name: who }, description: `${name}: ${description}`, plugins: [{ name, source: './', description }] }, null, 2) + '\n');
  fs.writeFileSync(path.join(c, '.claude-plugin', 'icon.png'), icon(name));
  write(path.join(c, 'LICENSE'), MIT(new Date().getFullYear(), who));
  write(path.join(c, 'README.md'), `# ${name}\n\n${description}\n\n## What it does\n\nIt runs ${steps.length} step${steps.length === 1 ? '' : 's'} in order: ${steps.map((s) => s.name + (s.missing ? ' (needs building: the AI asks before building it)' : '')).join(', then ')}. Before it starts it asks for anything it needs, and before it finishes it checks its own work.\n\n## How to use it\n\nPut this folder in its own GitHub repo, then in Claude Code: \`/plugin install ${name} --marketplace <owner>/<repo>\`. After that, ask for it in your own words or type \`/${name}\`. ${notFound.length ? `It also needs ${notFound.join(', ')}, which isn't included here.` : 'Everything it needs is included.'}\n\nMade visually on the Talenscape workbench. MIT license (see LICENSE); change it if you prefer another.\n`);
  for (const k of skills) write(path.join(c, 'skills', k.name, 'SKILL.md'), k.text);
  write(path.join(c, 'commands', `${name}.md`), `---\ndescription: "${description.replace(/"/g, "'")}"\n---\n\nUse the ${name} skill: follow its steps in order. $ARGUMENTS\n`);
  if (helper) write(path.join(c, 'agents', `${name}-reviewer.md`), `---\nname: ${name}-reviewer\ndescription: "Reviews the result of the ${name} plugin as ${helper.replace(/"/g, "'")}, before it's handed over."\n---\n\nYou review the result of the ${name} plugin as ${helper}. Say what to fix, plainly and briefly.\n`);

  // Gemini CLI extension.
  const g = path.join(out, 'gemini');
  write(path.join(g, 'LICENSE'), MIT(new Date().getFullYear(), author(root) ?? 'The author'));
  write(path.join(g, 'gemini-extension.json'), JSON.stringify({ name, version, description, contextFileName: 'GEMINI.md' }, null, 2) + '\n');
  write(path.join(g, 'GEMINI.md'), `# ${name}\n\n${description}\n\nThe steps are in the ${name} skill (skills/${name}/SKILL.md). Use it when the request fits.\n`);
  for (const k of skills) write(path.join(g, 'skills', k.name, 'SKILL.md'), k.text);
  write(path.join(g, 'commands', `${name}.toml`), `description = ${JSON.stringify(description)}\nprompt = """\nUse the ${name} skill: follow its steps in order.\n{{args}}\n"""\n`);

  // The plain standard folders.
  for (const k of skills) write(path.join(out, 'skills', k.name, 'SKILL.md'), k.text);

  write(path.join(out, 'README.md'), `# ${name}

${description}

Made with Talenscape. ${steps.length} step${steps.length === 1 ? '' : 's'}: ${steps.map((s) => s.name + (s.missing ? ' (needs building)' : '')).join(' → ')}.

## Claude Code
Copy \`claude/\` into its own repo, then: \`/plugin install ${name} --marketplace <owner>/<repo>\`.
Or just for one project: copy \`claude/skills/*\` into the project's \`.claude/skills/\`.

## Gemini CLI
\`gemini extensions install <path or repo of gemini/>\`, or copy \`gemini/\` into \`~/.gemini/extensions/${name}/\`.

## Codex / ChatGPT, Grok Build, Muse Code and other Agent Skills tools
Copy the folders in \`skills/\` into the tool's skills folder (for many, \`.agents/skills/\` in the project).
${notFound.length ? `\n## Not included\n${notFound.join(', ')}: not a skill file in this project (a tool or a catalog item). Whoever installs this needs it too.\n` : ''}`);
  return { out: path.relative(root, out), skills: skills.map((k) => k.name), notFound };
}

export function main([name]) {
  const r = exportPlugin(process.env.TALENSCAPE_ROOT || process.cwd(), name);
  if (r.error) { console.log(r.error); process.exitCode = 1; return; }
  console.log(`Exported to ${r.out}/ (Claude Code plugin, Gemini CLI extension, Agent Skills): ${r.skills.join(', ')}${r.notFound.length ? `. Not included (not skill files here): ${r.notFound.join(', ')}` : ''}`);
}
