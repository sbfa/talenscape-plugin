#!/usr/bin/env node
// Talenscape command line: build the map + search index, then ask short, size-limited questions.
// Read-only except `index`, which only writes the practice database in .city/city.db.
//
//   index [folder]            build or refresh (only changed files are re-read)
//   ask <words>               one-shot answer: where it is, what it connects to, the lines that matter
//   where <name>              where a function, class, skill or file is defined
//   deps <name>               what depends on it (uses it, calls it, imports it)
//   uses <name>               what it depends on
//   connect <a> <b>           shortest chain of links between two things
//   snip <name> [--sig|--body|--context]  one function/class: signature + doc (long ones), full body, or
//                             body inside its class/file context
//   search <words> [-n N]     plain text search, matching lines only
//   show <file> <from>-<to>   print just those lines of a file
// Add --budget N to any question to change its token limit.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildIndex } from './lib/indexer.mjs';
import { ask, where, deps, uses, impact, connect, snip, search, show, tokens } from './lib/query.mjs';

export { buildIndex, ask, where, deps, uses, impact, connect, snip, search, show };

const USAGE = `Usage: city <index|ask|where|deps|uses|connect|snip|search|show> …
  index [folder]           build or refresh the map and search index
  ask <words>              one-shot answer (location + links + key lines)
  where <name>             where it is defined
  deps <name>              what depends on it
  uses <name>              what it depends on
  impact <name>            what depends on it (2 levels) + which tests cover it
  connect <a> <b>          how two things are linked
  snip <name> [--sig|--body|--context]  one function or class (long ones start as signature + doc)
  search <words> [-n N]    matching lines only
  show <file> <from>-<to>  just those lines
  --budget N               token limit for the answer`;

function takeFlag(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args.splice(i, 2)[1]) || undefined : undefined;
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  const root = process.cwd();
  const budget = takeFlag(rest, '--budget');
  switch (cmd) {
    case 'index': {
      const s = await buildIndex(path.resolve(rest[0] ?? root));
      console.log(`Index ready: ${s.added} added, ${s.updated} updated, ${s.removed} removed, ${s.unchanged} unchanged. Map: ${s.nodes} pieces, ${s.edges} links.`);
      break;
    }
    case 'ask': console.log(ask(root, rest.join(' '), budget)); break;
    case 'where': console.log(where(root, rest.join(' '), budget)); break;
    case 'deps': console.log(deps(root, rest.join(' '), budget)); break;
    case 'uses': console.log(uses(root, rest.join(' '), budget)); break;
    case 'impact': console.log(impact(root, rest.join(' '), budget)); break;
    case 'snip': {
      const level = ['--sig', '--body', '--context'].find((f) => rest.includes(f))?.slice(2) ?? 'auto';
      const name = rest.filter((a) => !a.startsWith('--')).join(' ');
      const text = snip(root, name, budget, level);
      console.log(text);
      // The savings meter: did the short answer save tokens, or did the AI need the body after all?
      const used = text.includes('  more: snip ') ? 'sig' : level === 'auto' ? null : level;
      if (used && !text.startsWith('Not found')) {
        const { noteSnip } = await import('./lib/savings.mjs');
        const meterRoot = process.env.TALENSCAPE_ROOT || process.env.CLAUDE_PROJECT_DIR || root;
        noteSnip(meterRoot, name, used, used === 'sig' ? tokens(snip(root, name, 100000, 'body')) : 0, tokens(text));
      }
      break;
    }
    case 'connect':
      if (rest.length < 2) { console.log('Usage: connect <a> <b>'); process.exit(1); }
      console.log(connect(root, rest[0], rest[1], budget));
      break;
    case 'search': {
      const limit = takeFlag(rest, '-n') ?? 8;
      const hits = search(root, rest.join(' '), limit);
      console.log(hits.length ? hits.map((h) => `${h.path}:${h.line}  ${h.text}`).join('\n') : 'No matches.');
      break;
    }
    case 'show': {
      const [file, range] = rest;
      const [from, to] = (range ?? '').split('-').map(Number);
      if (!file || !from) { console.log('Usage: show <file> <from>-<to>'); process.exit(1); }
      console.log(show(root, file, from, to || from));
      break;
    }
    default:
      console.log(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
