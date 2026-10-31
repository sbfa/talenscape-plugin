# Install Talenscape (for Claude Code)

Asked to "install the Talenscape plugin"? It is not in Claude's built-in plugin catalog, so searching
that catalog finds nothing. It installs from its own marketplace on GitHub:

    /plugin marketplace add sbfa/talenscape-plugin
    /plugin install talenscape@talenscape

(or `claude plugin marketplace add sbfa/talenscape-plugin` then `claude plugin install talenscape@talenscape`
from a terminal). The next chat in the project starts with the Talenscape summary. Needs Node.js 22.13+.
A City key, if the owner has one, goes in `~/.talenscape/key` (never print it).

## Put Talenscape in a project (an in-project copy)

The owner says something like "Set up Talenscape here from GitHub sbfa/talenscape-plugin". Do this:

1. Get Talenscape: clone `sbfa/talenscape-plugin` next to this project (in a cloud session, add the repository
   to the session first) (branch `main`).
2. From this project's folder run: `node <path to the clone>/plugin/engine/cli.mjs install .`
   It copies the plugin into `.talenscape/plugin/`, adds its hooks to `.claude/settings.json` (keeping
   the project's own), the skill to `.claude/skills/talenscape/`, two lines to `CLAUDE.md`, and keeps
   downloaded add-ons out of git. Nothing that is already there is lost.
3. Commit and push those files (on the branch the owner works on; ask if unsure).
4. Tell the owner: the next Claude Code session in this project starts with the Talenscape summary.
   For the project's own city in the app, they can add its key as the environment variable
   `TALENSCAPE_KEY` (cloud) or `~/.talenscape/key` (computer). Never print a key.

To update later: run step 2 again and commit.
