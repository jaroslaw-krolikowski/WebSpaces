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
| `docs/05-backup.md` | Chrome sync, file export, and why there is no cloud integration |
| `docs/06-development.md` | build, tests, conventions |
| `docs/07-experimental.md` | features that rearrange user data, and their escape hatches |
| `docs/08-webstore.md` | store submission: listing copy, permission justifications, assets |

`README.md` is the user-facing entry point and repeats the essentials. `PRIVACY.md` is the
published privacy policy the store listing links to; it has to stay true of the code.

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
containers. That makes isolation **sequential, not parallel** - one container per realm at a
time. This is a property of the platform, not of the implementation.

## Non-negotiable rules

1. **Isolation beats convenience.** If the gate cannot be installed, fail loudly rather than
   letting traffic through unprotected. `refreshGate` falls back to a simpler rule set and
   logs it, but never to no rules at all.
2. **Never fail silently.** Every UI action goes through `run()` in `options.ts`, and `send()`
   turns any background failure into a throw. A button that does nothing is a bug.
3. **A tab that cannot prove its container is frozen, not guessed.** A frozen tab is blocked
   at the network layer. Never let it "probably" use the mounted session.
4. **Cookies never leave the machine automatically.** Chrome sync carries configuration only.
   File export can include cookies, but only behind an explicit opt-in and a confirmation
   dialog, because that file is something the user deliberately moves.
5. **A realm contains only hosts shared across organisations.** Hosts whose name carries the
   organisation stay out. See `docs/03-realms.md` - this is the single most consequential
   design rule in the project. A host missing from every realm fails **silently and towards
   leaking**: nothing swaps it, nothing freezes it, and every container shares one session on it.
   A wildcard in a realm gates and swaps but does not clear site data, so list the concrete hosts
   next to it.
6. **A container and a tab group are one thing.** Changes flow both ways. Never introduce a
   second parallel list that has to be reconciled by hand.
7. **Container names are unique** - the name doubles as the tab group title and as the
   fallback binding after a browser restart.

## Code conventions

- TypeScript `strict: true`, plus `noUncheckedIndexedAccess` and `noUnusedLocals`
- Comments in English; no framework, no runtime dependencies
- **No user-visible string in the source.** Every one lives in `_locales/en/messages.json` and
  reaches the page through `data-i18n` or `t()`. `npm test` fails on a key that does not exist,
  and warns when a translation falls back. `_locales/en` must stay complete, because it is what
  every other locale falls back to.
- **ASCII punctuation only.** Never use an em dash, write a plain hyphen instead. The long dash
  reads as machine-written text, which is not the impression this project should give.
- Component and module files in kebab-case directories, camelCase exports
- `types.ts` and `realms.ts` must not touch `chrome.*` at runtime, because the Node tests import
  them directly. The rest of `src/shared/` is free to use the browser APIs.
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
  the next state read. The flip side is that a preset gaining a host later never reaches an
  existing installation, which is what `src/background/migrate.ts` is for: it adds hosts and
  never removes them, under a step id that is recorded once per device. Add a new id rather than
  editing an old one.
- Do not call `assignTabToContainer` outside its queue. Concurrent calls each read the group list
  before any of them creates a group, and Chrome ends up with several groups of the same name -
  which, since Chrome saves groups, leaves a duplicate chip behind for good.
- **Do not add a cloud provider integration.** Google Drive was built and removed. Any provider
  API needs a client ID, and a client ID belongs to someone: ship one and every user reaches the
  cloud through the maintainer project and responsibility, or make each user register their own
  and setup moves into a console outside the extension. For a store-published extension neither
  is acceptable, and `chrome.storage.sync` already covers the configuration. Tabs and windows
  belong in an export file the user controls. See `docs/05-backup.md` for the full account.
- Do not let `pushToSync` write an unchanged payload. Applying a remote change saves local
  state, which triggers a push, which the other device applies - the two would bounce the same
  configuration forever. The equality check in `pushToSync` is what stops it, and the writer id
  in the metadata guards the same loop within one device.
- **Every experimental feature must be reversible by one switch**, and switching it off must
  leave things exactly as visible as before. Per-container bookmarks physically move entries, so
  the way back matters more than the feature.
- Do not reintroduce a bypass that opens the isolation gate. One existed while the Drive
  sign-in page had to load, and a gate that can be switched off is a gate you cannot reason
  about. Nothing in the extension needs to reach a realm host outside a container.

## Environment notes

- The extension id of an unpacked extension depends on its directory path, so it changes when
  the project moves. Nothing depends on it any more, but it is worth knowing before something
  starts to.
- Icons are generated from `src/logo-webspaces.png` by `npm run icons`. Rerun it only when the
  logo changes; the generated files are committed.
- Bash heredocs in this environment mangle `\\` sequences and break on apostrophes in prose.
  Use the Write tool for files containing either.
