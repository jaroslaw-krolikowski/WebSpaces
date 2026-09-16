# CLAUDE.md

Project context for Claude Code. Read this file in full before the first change.

## What this project is

WebSpaces is a Chrome extension that brings Firefox-style container tabs to Chrome,
built on **native Chrome tab groups**. A container is a tab group with a cookie vault
attached. It exists because Microsoft SSO has no per-organisation endpoint: every tenant
signs in through `login.microsoftonline.com`, so the `ESTSAUTH*` cookies collide and you
cannot stay signed into two tenants at once.

The same pattern applies to Atlassian, Google, AWS and GitHub, which ship as presets.

## Documentation

Read in this order:

| File | Contents |
|---|---|
| `docs/01-architecture.md` | modules, data flow, where each decision lives |
| `docs/02-isolation.md` | the gate, mounting, the vault, and what is out of reach |
| `docs/03-realms.md` | how to choose realm hosts, and why that choice matters |
| `docs/04-rules.md` | opening rules and pattern semantics |
| `docs/05-backup.md` | Google Drive backup and file export |
| `docs/06-development.md` | build, tests, conventions |

`README.md` is the user-facing entry point and repeats the essentials.

## Platform constraints that shaped everything

These are verified facts, not assumptions. Do not design around them being false.

1. **Chrome has no per-tab cookie store.** There is no `contextualIdentities` equivalent.
   `chrome.cookies` does not support partitioning; it reads and writes across all partitions.
2. **`declarativeNetRequest` cannot modify the `Cookie` header.** A rule targeting it passes
   validation, throws nothing, and the original header is sent anyway
   ([crbug 40825809](https://issues.chromium.org/issues/40825809)).
3. **MV3 removed blocking `webRequest`.** The classic per-tab `Cookie` rewrite is gone for
   Web Store extensions, and MV2 left the Web Store on 2026-08-31.

The only remaining mechanism is swapping cookies through `chrome.cookies` when switching
containers. That makes isolation **sequential, not parallel** — one container per realm at a
time. This is a property of the platform, not of the implementation.

## Non-negotiable rules

1. **Isolation beats convenience.** If the gate cannot be installed, fail loudly rather than
   letting traffic through unprotected. `refreshGate` falls back to a simpler rule set and
   logs it, but never to no rules at all.
2. **Never fail silently.** Every UI action goes through `run()` in `options.ts`, and `send()`
   turns any background failure into a throw. A button that does nothing is a bug.
3. **A tab that cannot prove its container is frozen, not guessed.** A frozen tab is blocked
   at the network layer. Never let it "probably" use the mounted session.
4. **Cookies never leave the machine automatically.** The Drive backup holds configuration and
   the tab tree only. File export can include cookies, but only behind an explicit opt-in and
   a confirmation dialog.
5. **A realm contains only hosts shared across organisations.** Hosts whose name carries the
   organisation stay out. See `docs/03-realms.md` — this is the single most consequential
   design rule in the project.
6. **A container and a tab group are one thing.** Changes flow both ways. Never introduce a
   second parallel list that has to be reconciled by hand.
7. **Container names are unique** — the name doubles as the tab group title and as the
   fallback binding after a browser restart.

## Code conventions

- TypeScript `strict: true`, plus `noUncheckedIndexedAccess` and `noUnusedLocals`
- Comments and UI text in English; no framework, no runtime dependencies
- Component and module files in kebab-case directories, camelCase exports
- `src/shared/` must not touch `chrome.*` at runtime, so it stays unit-testable in Node
- Anything non-obvious gets a comment explaining **why**, not what

## What not to do

- Do not raise isolation promises beyond sequential. Parallel isolation needs separate Chrome
  profiles and a native messaging host; that is a different product.
- Do not reverse engineer competing extensions. The API surface leaves exactly one approach,
  so there is nothing to learn that is not already in `docs/02-isolation.md`.
- Do not add `*.sharepoint.com`, `*.atlassian.net` or `*.awsapps.com` to a preset realm.
  Those hosts carry the organisation name and do not collide; freezing them costs the user
  parallel tabs for nothing.
- Do not remove the `tabIds: [-1]` allow rule. Requests with no tab (downloads handed to the
  download manager) cannot be attributed to a container; blocking them breaks downloads
  without buying isolation.
- Do not drop the `seeded` flag. Without it, deleting every realm resurrects the presets on
  the next state read.
- Do not commit `google-client-id.txt`. It is gitignored and injected at build time.

## Environment notes

- The extension id of an unpacked extension depends on its directory path. Moving the project
  changes the id and breaks the OAuth client binding in Google Cloud.
- Bash heredocs in this environment mangle `\\` sequences and break on apostrophes in prose.
  Use the Write tool for files containing either.
