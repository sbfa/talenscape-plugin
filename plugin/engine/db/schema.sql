-- Talenscape database. Plain SQLite, written to run unchanged on Cloudflare D1.
-- The practice copy lives in .city/city.db; the real one will be the owner's D1 database.

CREATE TABLE IF NOT EXISTS files (
  path     TEXT PRIMARY KEY,
  hash     TEXT NOT NULL,
  size     INTEGER NOT NULL,
  mtime    REAL NOT NULL,
  lang     TEXT,
  district TEXT,
  changed_at INTEGER,         -- last commit that touched it (unix time), from git history
  runs     INTEGER NOT NULL DEFAULT 0  -- 1 = run directly (#! line, Python __main__ check)
);

-- Files that change together in git history without an import between them (hidden coupling).
CREATE TABLE IF NOT EXISTS cochange (
  a        TEXT NOT NULL,
  b        TEXT NOT NULL,
  together INTEGER NOT NULL,     -- commits that touched both
  jaccard  REAL NOT NULL,        -- together / min(changes of a, changes of b)
  PRIMARY KEY (a, b)
);

-- Nodes: file, class, function, method, skill. Ids are short integers to keep answers small.
CREATE TABLE IF NOT EXISTS graph_nodes (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  qname      TEXT NOT NULL,      -- e.g. "Router.handle" or "res.sendFile"
  path       TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line   INTEGER NOT NULL,
  parent     INTEGER,            -- enclosing node (file for top-level symbols)
  district   TEXT,
  main       INTEGER NOT NULL DEFAULT 0, -- 1 = what its file exports by default
  rank       REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS graph_nodes_name ON graph_nodes (name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS graph_nodes_path ON graph_nodes (path, start_line);

-- Raw references found while parsing, kept so edges can be re-resolved when other files change.
CREATE TABLE IF NOT EXISTS graph_refs (
  src    INTEGER NOT NULL,       -- node that makes the reference
  kind   TEXT NOT NULL,          -- imports | binds | calls | inherits | mentions
  target TEXT NOT NULL,          -- a name, an import path, or "name path [original]" for binds
  line   INTEGER NOT NULL,
  path   TEXT NOT NULL           -- file the reference is in
);
CREATE INDEX IF NOT EXISTS graph_refs_path ON graph_refs (path);

CREATE TABLE IF NOT EXISTS graph_edges (
  src  INTEGER NOT NULL,
  dst  INTEGER NOT NULL,
  kind TEXT NOT NULL,            -- imports | calls | inherits | mentions
  line INTEGER NOT NULL,
  PRIMARY KEY (src, dst, kind)
);
CREATE INDEX IF NOT EXISTS graph_edges_dst ON graph_edges (dst);

CREATE VIRTUAL TABLE IF NOT EXISTS snippet_fts USING fts5(
  path UNINDEXED, start_line UNINDEXED, end_line UNINDEXED, body,
  tokenize = "unicode61 tokenchars '_'"
);

CREATE TABLE IF NOT EXISTS skills (
  name        TEXT NOT NULL,
  path        TEXT PRIMARY KEY,
  area        TEXT NOT NULL,     -- catalog | user
  model       TEXT,              -- claude | chatgpt | gemini | grok (user skills)
  description TEXT,
  triggers    TEXT,              -- comma-separated
  version     TEXT,
  plugin      TEXT,              -- the plugin (bundle) it belongs to, if any
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_handoffs (
  id          INTEGER PRIMARY KEY,
  created_at  TEXT NOT NULL,
  goal        TEXT,
  last_action TEXT,
  next_task   TEXT,
  blockers    TEXT
);

CREATE TABLE IF NOT EXISTS highway_packets (
  packet_id     TEXT PRIMARY KEY,
  source_domain TEXT NOT NULL,
  target_domain TEXT NOT NULL,
  intent        TEXT,
  symbol        TEXT,
  snippet_hash  TEXT,
  telemetry     TEXT,            -- JSON
  status        TEXT NOT NULL DEFAULT 'queued',
  created_at    TEXT NOT NULL
);
