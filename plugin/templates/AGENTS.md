If you are Claude Code with the Talenscape plugin: run `city blink` and follow it; look things up with
`city ask <words>` instead of opening files.

Any other AI (Grok, Meta Muse, ChatGPT… reading this project, e.g. through GitHub):
0. First time here? Open your own file in `shared/` (grok.md, muse.md, chatgpt.md, gemini.md) and do
   its one-time setup. No file for you? Create `shared/<you>.md` following `shared/README.md`.
1. Read `.city/BLINK.md`: the same session summary Claude Code starts with (the owner's rules, decisions,
   where things stand, what's next, lessons). Its rules apply to you too.
2. Then `.city/MAP.md`: the project's skills and its areas. Know the name you need? Open
   `.city/names/<first two letters>.md`, e.g. `pi.md` for pick (where it is, its small file). Otherwise open only the area you need
   (`.city/map/<area>.md`: every file there, its pieces and their lines). Every piece of code is also its
   own small file, `.city/snips/<file>/<name>.txt`: open that, never whole files. A long piece shows its
   start and names `<name>.full.txt` for the rest: open that only if the start isn't enough.
   `.city/GRAPH.md`: what calls what.
3. Do whatever task the owner asks with that context: plan, review, explain, write code or text.
4. Only the owner or Claude Code changes this project. Hand changes back as text or a patch in your
   reply; don't edit files, commit, push or open pull requests here. The exceptions: your own list in
   `shared/<you>.md`, and notes for the others in the library, `shared/notes/` (see its README).
5. **Saving something for the others** (a note, a picture, a file), every time:
   - Where: this project's GitHub repo (the one the owner gave you), branch `main`, folder `shared/notes/`. Nowhere else: not another branch, not a new repo, and not
     only in your chat (nobody else can see your chat).
   - Names: a note is `shared/notes/<you>-<yyyy-mm-dd>-<topic>.md`; a picture or other file is
     `shared/notes/<you>-<yyyy-mm-dd>-<topic>.png` (or .jpg, .pdf…), with a short `.md` note next to it
     saying what it is and what it's for.
   - It only counts once it's committed: end your reply with the commit link. No link means not saved:
     say so, never "done".
   - Can't save it (for example your GitHub tool only takes text)? Say so plainly and tell the owner how
     to download it from your chat, so Claude Code can put it there.
   - Never keys or passwords.
6. **Making a skill, a tool or a plugin?** Follow `.city/FORMATS.md` exactly (header blocks, file
   names, `plugin.json`): it's what the AI tools check, and plugins made without it often don't install.
