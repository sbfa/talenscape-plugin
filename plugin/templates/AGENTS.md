If you are Claude Code with the Talenscape plugin: run `city blink` and follow it; look things up with
`city ask <words>` instead of opening files.

Any other AI (Grok, Meta Muse, ChatGPT… reading this project, e.g. through GitHub):
0. First time here? Open your own file in `shared/` (grok.md, muse.md, chatgpt.md, gemini.md) and do
   its one-time setup. No file for you? Create `shared/<you>.md` following `shared/README.md`.
1. Read `.city/BLINK.md`: the same session summary Claude Code starts with (the owner's rules, decisions,
   where things stand, what's next, lessons). Its rules apply to you too.
   Can you run commands (Grok Build, Gemini CLI…)? Run `city blink` (from `.talenscape/plugin/bin/`) instead: the same summary, and it
   first brings in what the owner added in the app.
   The owner's habits (OWNER and RULES lines) change with `city habit` (run it for how).
   Then `.city/APP.md` if it is there: what the owner set in the Talenscape app (habits, their skills,
   notes), written by the app seconds after each change. Newer than the blink: where they differ, it wins.
   The owner says **"sync"** (mid-chat): read `.city/APP.md`, `.city/BLINK.md` and `shared/notes/` again,
   fresh from GitHub (not from memory), then say in one line what changed.
2. Then `.city/MAP.md`: the project's skills and its areas. Know the name you need? Open
   `.city/names/<first two letters>.md`, e.g. `pi.md` for pick (where it is, its small file). Otherwise open only the area you need
   (`.city/map/<area>.md`: every file there, its pieces and their lines). Every piece of code is also its
   own small file, `.city/snips/<file>/<name>.txt`: open that, never whole files. A long piece shows its
   start and names `<name>.full.txt` for the rest: open that only if the start isn't enough.
   A question about another of the owner's projects: an exact word (a price, ID, address, name)? Search
   for it first (Claude Code: `city catalog find <words>`). Vague? `.city/catalog/COMPANY.md` (every
   project in one place), then that project's card `.city/catalog/<project>.md` (its key files; small ones
   say "open it whole"), then only the lines you need. Read the company file once per chat, not per question.
   Asked what something is or is called? Check the file the search or card names before answering. `.city/NOTES.md`: the notes from the others meant for you, each with its corrections (skip
   the ones listed as replaced). `.city/GRAPH.md`: what calls what.
3. Do whatever task the owner asks with that context: plan, review, explain, write code or text.
4. Only the owner or Claude Code changes this project. Hand changes back as text or a patch in your
   reply; don't edit files, commit, push or open pull requests here. The exceptions: a skill the blink tells you to write
   up (step 7), your own list in `shared/<you>.md`, and notes for the others in the library, `shared/notes/` (see its README).
5. **Saving something for the others** (a note, a picture, a file), every time:
   - Where: this project's GitHub repo (the one the owner gave you), branch `main`, folder `shared/notes/`. Nowhere else: not another branch, not a new repo, and not
     only in your chat (nobody else can see your chat).
   - Names: a note is `shared/notes/<you>-<yyyy-mm-dd>-<topic>.md`; a picture or other file is
     `shared/notes/<you>-<yyyy-mm-dd>-<topic>.png` (or .jpg, .pdf…), with a short `.md` note next to it
     saying what it is and what it's for.
   - Start a note with a short header, then the `# Title` line:
     `---` / `author: <you>` / `date: <yyyy-mm-dd>` / `to: [claude]` (who should read it; leave it out
     for all four: claude, muse, grok, gemini) / `amends: [<note>]` (it corrects part of an earlier note)
     or `supersedes: [<note>]` (it replaces a whole earlier note) / `---`. Name earlier notes by file name
     without `.md`. A correction automatically reaches everyone the corrected note reaches. A broken header
     fails the "Note headers" check on GitHub, naming the file and the field.
   - It only counts once it's committed: end your reply with the commit link. No link means not saved:
     say so, never "done".
   - Can't save it (for example your GitHub tool only takes text)? Say so plainly and tell the owner how
     to download it from your chat, so Claude Code can put it there. Can't save to GitHub at all (Gemini)?
     Give the owner the whole note, header included, as one block to paste to Claude Code, which saves it.
   - Never keys or passwords.
6. **Making a skill, a tool or a plugin?** Follow `.city/FORMATS.md` exactly (header blocks, file
   names, `plugin.json`): it's what the AI tools check, and plugins made without it often don't install.
7. **Write up** (the blink has a `WRITE UP` line naming you): the owner made that skill in the app,
   in their own words. Write it up properly, once, in that same file: a clear `description` (what it
   does and when to use it), `triggers`, and complete numbered steps, spelled right, keeping the owner's
   meaning (fill an empty step from the rest, or leave it out). Keep `name`, `models` and `draft`
   exactly; change `status: draft` to `status: written`. Never keys or passwords. Then tell the owner
   in one line what you wrote, and save it like a note (step 5's commit rules), or with Claude Code.
