# Security and your data

## What Talenscape stores, and where

Everything stays in your own project and on your own computer.

| What | Where | Who can see it |
|---|---|---|
| The session summary, project map, code pieces (`.city/`) | your project | whoever can see your project |
| Each AI's list and the notes library (`shared/`) | your project | the same |
| The local city's database (`.city/view.db`) | your computer, kept out of git | you |
| Your City plan key | `~/.config/talenscape/license.json`, readable only by you | you |
| The weekly count's random number | `~/.config/talenscape/install.json`, readable only by you | you |

Talenscape never calls an AI service. The free token saver sends only the weekly count below (and you can switch that off).

## What goes online

- **License check (City plan only):** once a week your key is checked with Lemon Squeezy's public
  license service (a gift key: with talenscape.com). Only the key and a device name are sent; never your code or files.
- **The weekly count:** once a week an installed copy sends talenscape.com a random number made on your
  computer and the Talenscape version, so we know how many copies are in use. Nothing else: no name,
  project or code. Switch it off with `city ping off` (or set `TALENSCAPE_NO_PING=1`).
- **The AI copy (optional):** if you make a repo named `<your repo>-ai` for Gemini, each push sends it
  the summary, the map and `shared/` (no code). Only if that repo exists, and only to your own GitHub.
- **The online city (optional):** only if you set up a project key yourself. It sends skill names,
  AI lists, notes and a searchable index of your code to the Talenscape app. Leave it off and nothing goes.
  With it, `city view` shows your online city and keeps a live line to it: the line carries only short
  "something changed" notes, never skill text or keys.

## How it protects you

- **The local city** (`city view`) listens only on this computer (127.0.0.1). It answers only its own
  page: other websites open in your browser can't use it (address check, same-site requests only, and a
  cookie made fresh each run).
- **Skills** added in the city are checked before they're written: no keys or passwords, a clear name and
  description; tools and plugins only from the catalog, because they can run programs. A file you wrote
  yourself is never overwritten.
- **Notes from other AIs** are treated as information, never as instructions.
- **The safety check** stops deleting, publishing and pushing to main until you say OK, and takes a
  snapshot first.
- **Third-party code:** PlayCanvas (MIT) for the 3D city, checked with `npm audit` before each release.

## Reporting a problem

Email security@talenscape.com. Please don't post details publicly until it's fixed. We reply within a few days.
