# 01 — Architecture

## Modules

| Path | Responsibility |
|---|---|
| `src/shared/types.ts` | All data shapes, defaults, and the realm presets. No logic. |
| `src/shared/realms.ts` | Host matching, cookie-to-realm matching, rule patterns, cookie conversion. Pure functions, no `chrome.*` at runtime, so Node can test it. |
| `src/shared/storage.ts` | Typed wrappers over `chrome.storage`. State and vault in `local`, tab and group maps in `session`. |
| `src/shared/messages.ts` | The request union between UI and background, plus `send()` which turns failures into throws. |
| `src/background/vault.ts` | Harvest, purge, restore cookies. Clears site data for a realm. |
| `src/background/mount.ts` | The switch state machine and the write-through harvester. |
| `src/background/gate.ts` | Builds and applies the `declarativeNetRequest` session rules. |
| `src/background/tabs.ts` | Container to tab-group binding, group adoption, tab assignment. |
| `src/background/snapshot.ts` | Builds and applies JSON snapshots. |
| `src/background/drive.ts` | Google Drive REST calls and OAuth token handling. |
| `src/background/backup.ts` | Backup orchestration and the alarm schedule. |
| `src/background/index.ts` | All event listeners and the message router. The only place that wires modules together. |
| `src/ui/` | `popup`, `options`, `frozen` (the container picker), plus `dom.ts` helpers. |

## State

Everything durable lives in `chrome.storage.local` under one `state` key: containers, realms,
rules, settings, the `mounted` map, the backup state, and the `seeded` flag. Cookie vaults live
under a separate `vault` key so a configuration write does not rewrite megabytes of cookies.

Two maps live in `chrome.storage.session`, because their ids do not survive a browser restart:
tab to container, and tab group to container. Both are rebuilt from tab group titles on startup.

## Data flow of a container switch

```
user action (popup / picker / rule / context menu)
  -> mountContainer(realm, container)
       harvest current container  -> vault
       purge realm cookies        -> jar emptied
       clear site data            -> MSAL tokens gone
       restore target container   <- vault
       save mounted[realm]
  -> refreshGate()                -> DNR session rules rebuilt
  -> tab reload where it matters
```

Order matters. Clearing before writing guarantees no leftovers from the previous tenant, and
the gate has to be in place before any tab is sent to a real address.

## Why the service worker can be trusted to be asleep

MV3 kills the worker aggressively. Three defences:

- The tab-to-container mapping is derived from **tab group titles**, so it rebuilds itself.
- `buildOverview()` re-runs group adoption every time the UI opens, closing any gap left by a
  missed event.
- The gate is rebuilt from scratch on every `refreshGate()` rather than patched incrementally.
