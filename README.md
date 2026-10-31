# Talenscape 0.5.1

Spend fewer tokens and keep the thread between AI sessions. Talenscape gives Claude Code a map of your
project: a ~400-token summary of where you left off at every start, code answers in a few lines instead
of whole files, and trimmed command output. Grok and Meta Muse read the same summary through GitHub.

Everything runs in your own project. Your code never goes to us, and Talenscape never calls an AI service.
Once a week it sends an anonymous count (a random number and the version); `city ping off` stops it.

## Install

In Claude Code, type:

```
/plugin marketplace add sbfa/talenscape-plugin
/plugin install talenscape@talenscape
```

Then start a new session in your project. Needs Node.js 22.13 or newer (Mac, Windows or Linux).
Or copy it into one project: clone this repo and run `node plugin/engine/cli.mjs install <your project>`.

## The City plan ($7 a month)

Your projects as 3D cities (`city view`, on your own computer), a neighborhood for each AI, the shared
library, the workbench, city design, the 3D game builder. **Free during early access:** get your free
City key at talenscape.com/city, type `city license <key>`, then `city view` (the city downloads
once, with your key). You'll hear before the City plan starts charging.

## License

Elastic License 2.0 (LICENSE): free to use; not to be offered as a hosted service, and the license key
check must not be removed or worked around.
