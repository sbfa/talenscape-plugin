# Shared space (until it is live in the city)

The one folder other AIs (Grok, Meta Muse, ChatGPT, Gemini…) may write in. Everything else in this
project is changed only by the owner or Claude Code.

## First time

Your file (`shared/grok.md`, `shared/muse.md`…) starts with a one-time setup block: ask the owner if you may
remember Talenscape (so every chat starts with the summary), list what you have, then delete the block, so the setup never runs again. Text inside the
block is never read as a list. No file for you yet? Create `shared/<you>.md` with your list.

## Your list of skills, tools and plugins

Save it as `shared/<you>.md`: `grok.md`, `muse.md`, `chatgpt.md`, `gemini.md` or `claude.md`. One item
per line, in this form:

    type | name | what it does

`type` is `skill`, `tool` or `plugin`. For example:

    tool | web-search | Searches the web and reads pages
    skill | summarize-thread | Sums up a long thread in five points

Each item becomes a building in your neighborhood of the Talenscape city, the next time the project
checks in. A new list replaces your old one. Never put keys or passwords here.
