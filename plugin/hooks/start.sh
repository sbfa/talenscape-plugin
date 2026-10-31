#!/bin/sh
# Talenscape session start: install the engine's add-ons once, put `city` on the AI's command
# path when running from a project checkout, then print the blink summary.
HERE="$PWD"
# What Claude Code says about this start (startup, resume, compact or clear), read once before anything else runs.
[ -t 0 ] || TALENSCAPE_HOOK_INPUT="$(cat)"; export TALENSCAPE_HOOK_INPUT
PLUGIN="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PLUGIN" || exit 0
if ! node -e "import('web-tree-sitter')" >/dev/null 2>&1; then
  if [ -n "$CLAUDE_PLUGIN_DATA" ]; then
    # Installed as a plugin: keep add-ons in the plugin's own storage so they survive updates.
    mkdir -p "$CLAUDE_PLUGIN_DATA" && cp package.json "$CLAUDE_PLUGIN_DATA/" &&
      (cd "$CLAUDE_PLUGIN_DATA" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock --silent) >/dev/null 2>&1 &&
      ln -sfn "$CLAUDE_PLUGIN_DATA/node_modules" "$PLUGIN/node_modules"
  else
    npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock --silent >/dev/null 2>&1
  fi
fi
# A plugin's bin/ is on the path already; a project checkout needs it added.
if [ -n "$CLAUDE_ENV_FILE" ] && [ -z "$CLAUDE_PLUGIN_ROOT" ]; then
  echo "export PATH=\"$PLUGIN/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi
# With the owner's project key: send this project's skills to the app and bring back what was added
# there (quiet unless something changed; never holds up or breaks the session).
cd "${CLAUDE_PROJECT_DIR:-$HERE}" && node --no-warnings "$PLUGIN/engine/cli.mjs" sync --quiet 2>/dev/null
# The same hooks at the "front door" (the folder holding all the owner's projects), for chats opened there.
node --no-warnings "$PLUGIN/engine/cli.mjs" frontdoor --quiet 2>/dev/null
exec node --no-warnings "$PLUGIN/engine/session.mjs" blink
