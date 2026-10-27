# Put Talenscape in a project (for Claude Code)

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
