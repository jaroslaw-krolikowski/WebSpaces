# 01 - Architecture

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
| `src/background/sync.ts` | Configuration sync through chrome.storage.sync. |
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

## Which container a new tab gets

`tabs.onCreated` decides, and the two cases pull in opposite directions.

A tab opened **from** a container tab inherits that container: `target="_blank"` links, popups and
download windows. Without it a download window landed in the default container, hit the gate as
frozen, and died with no message at all.

A **blank new tab** does not inherit, and is moved out of its group when Chrome placed it in one.
Ctrl+T is starting fresh, not following a link, and a new tab appearing inside a client's group is
both surprising and a way to visit the wrong place with the wrong session.

Chrome reports both cases identically when the tab is created, so the plus button at the end of a
group - a deliberate way of adding a tab to that group - cannot be told apart from Ctrl+T. That is
what `newTabInDefault` is for: it is on by default and switching it off restores Chrome's own
grouping. `about:blank` deliberately does not count as blank, because that is where a download
window starts.

## Why the service worker can be trusted to be asleep

MV3 kills the worker aggressively. Three defences:

- The tab-to-container mapping is derived from **tab group titles**, so it rebuilds itself.
- `buildOverview()` re-runs group adoption every time the UI opens, closing any gap left by a
  missed event.
- The gate is rebuilt from scratch on every `refreshGate()` rather than patched incrementally.
