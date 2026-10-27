// Opens the practice copy of the Talenscape database (same tables as the cloud D1 one).

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
// Bump when schema.sql changes; an older practice copy is then rebuilt from scratch.
const SCHEMA_VERSION = 4; // bump whenever parsing changes: forces a full re-read everywhere

// .city/ holds the map and scratch files; only the session notes are meant to be saved in git.
export const CITY_GITIGNORE = '# Talenscape: keep only the session notes and what other AIs read\n*\n!.gitignore\n!state.json\n!BLINK.md\n!MAP.md\n!GRAPH.md\n!FORMATS.md\n!facts.md\n!HANDOFF.md\n!layout.json\n!design.json\n!snips/\n!snips/**\n!map/\n!map/**\n!names/\n!names/**\n';

export function openDb(root) {
  fs.mkdirSync(path.join(root, '.city'), { recursive: true });
  const ignore = path.join(root, '.city', '.gitignore');
  // Write it once, and refresh our own copy when the template changes (a user's own file is left alone).
  const current = fs.existsSync(ignore) ? fs.readFileSync(ignore, 'utf8') : null;
  if (current === null || (current !== CITY_GITIGNORE && current.startsWith('# Talenscape:'))) fs.writeFileSync(ignore, CITY_GITIGNORE);
  const file = path.join(root, '.city', 'city.db');
  let db = new DatabaseSync(file);
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version !== SCHEMA_VERSION) {
    const hasTables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n > 0;
    if (hasTables) {
      db.close();
      for (const f of [file, file + '-wal', file + '-shm', file + '-journal']) fs.rmSync(f, { force: true });
      db = new DatabaseSync(file);
    }
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  return db;
}
