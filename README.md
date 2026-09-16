# WebSpaces

Firefox-style container tabs for Chrome, built on **native Chrome tab groups**. Each container
is a tab group with its own cookie vault.

It exists for one concrete problem: **Microsoft SSO has no per-organisation endpoint.** Every
tenant signs in through `login.microsoftonline.com`, so the `ESTSAUTH*` cookies collide and you
cannot stay signed into two tenants at once. The same applies to Atlassian, Google, AWS and
GitHub, which ship as presets.

## Install

```bash
npm install
npm run build
```

Then `chrome://extensions` → **Developer mode** → **Load unpacked** → pick the `dist` directory.

## Concepts

| Term | Meaning |
|---|---|
| **Container** | A tab group plus a cookie vault. A container and a group are **one thing**, not two lists to reconcile. |
| **Realm** | A set of hosts whose cookies collide between containers. Only those are ever swapped. |
| **Gate** | A `declarativeNetRequest` layer that stops a tab of a non-mounted container from sending anything. |
| **Mounting** | Putting a container vault into the browser cookie jar. One container per realm at a time. |

## Tab groups and containers are the same thing

The binding works both ways:

- **Group to container.** A named group created by hand in Chrome becomes a container
  automatically. Renaming or recolouring it carries over.
- **Container to group.** Adding a container in settings does not create a group yet - a Chrome
  group cannot be empty, so it appears with the first tab you move into it.
- **Tab to tab.** A tab opened from a container tab inherits that container. This covers
  `target="_blank"` links, popups and download windows.

Groups **without a name** are skipped: there is nothing to identify them by after a restart,
when Chrome assigns fresh group ids. Closing the last tab of a group does **not** delete the
container - the vault has to survive closing a window.

## How isolation works

Chrome has no per-tab cookie jar, MV3 removed blocking `webRequest`, and
`declarativeNetRequest` [cannot modify the `Cookie` header](https://issues.chromium.org/issues/40825809)
- a rule targeting it passes validation and does nothing. The only mechanism left is swapping
cookies when you switch containers, which is what every extension in this class does.

What makes that safe here is a network gate. Three rule layers per realm:

```
priority 1  redirect  main_frame  ->  container picker   (globally, realm hosts)
priority 2  allow     tabs of the mounted container      (every resource type)
priority 2  allow     requests with no tab (downloads)
priority 3  block     tabs of a non-mounted container    (everything but main_frame)
```

A tab outside the active container is **frozen at the network layer** - it cannot send a single
request, so it cannot rotate someone else's session. Instead of a silent session drift you get
an explicit state and a one-click switch. Layer 1 also gives you the Firefox-style "which
container should open this?" prompt for free.

Each switch also clears `localStorage`, `indexedDB` and `cacheStorage` for the realm hosts.
That is not decoration: M365 portals are MSAL applications and keep **access tokens in
`localStorage`**, not in cookies. Without it a tab could keep working on the previous tenant
token for about an hour. It can be turned off in settings, at the cost of tightness.

## What this does not do

Worth knowing up front rather than discovering in front of a client:

1. **Isolation is sequential, not parallel.** One container per realm at a time. Two tabs of
   the same portal in two tenants **will not work simultaneously** - the second is frozen. This
   is a platform limit, not an implementation gap. Firefox isolates in parallel because it does
   so in the engine. Commercial extensions hit the same wall; SessionBox shipped a separate
   desktop client for exactly this reason.
2. **Requests with no tab pass the gate deliberately.** Downloads handed to the download
   manager and fetches from a page service worker have `tabId = -1` and cannot be attributed to
   a container. Blocking them breaks downloads without buying isolation - the container
   decision was already made at navigation time.
3. **Wildcard hosts are not cleared of site data.** `browsingData` needs concrete origins, so
   `*.office.com` is gated but its localStorage is not cleared.
4. **This is not an anti-detect tool.** IP address, browser fingerprint and history stay shared,
   exactly as in Firefox containers.
5. **The vault is unencrypted**, in `chrome.storage.local`. Anyone with access to the Chrome
   profile has access to the saved sessions, much like the native cookie database.

If you need **true parallelism**, the only route in Chrome is separate profiles
(`chrome.exe --profile-directory=...`). An extension has no API to drive those; it would take a
native messaging host and an install outside the Web Store.

## Realms

The bundled realms are **presets, not a closed list** - edit, delete, or add your own. A deleted
preset can be restored from the dropdown in settings.

| Preset | Shared sign-in surface |
|---|---|
| Microsoft 365 / Entra ID | `login.microsoftonline.com`, `admin.microsoft.com`, `portal.azure.com` |
| Atlassian (Jira, Confluence) | `id.atlassian.com`, `admin.atlassian.com`, `start.atlassian.com` |
| Google | `accounts.google.com`, `admin.google.com` |
| Amazon Web Services | `signin.aws.amazon.com`, `console.aws.amazon.com` |
| GitHub | `github.com` |

### How to pick hosts

A realm holds only what is **shared across organisations**, because that is the only place
cookies collide. Hosts whose name carries the organisation stay **out**:

| In the realm | Outside the realm |
|---|---|
| `login.microsoftonline.com` | `contoso.sharepoint.com` |
| `id.atlassian.com` | `acme.atlassian.net` |
| `signin.aws.amazon.com` | `acme.awsapps.com` |

The payoff is practical: **two Jira instances from different companies run side by side**,
because their hosts do not overlap. Only two Atlassian sign-in screens need a container switch.
The narrower your realm, the fewer tabs get frozen.

A realm with no hosts is harmless - it simply does nothing. No realms at all means containers
are just labels on tab groups.

## Opening rules

Rules work for **every address**, not only realm hosts. They are a purely organisational layer,
independent of cookie isolation.

```
example.com                  whole site including subdomains (also www.example.com)
https://example.com/         the same; scheme and trailing slash are ignored
admin.microsoft.com/*        narrowed to paths under that host
*.sharepoint.com             any SharePoint tenant
```

A bare host means the site, so `example.com` also catches `www.example.com` - otherwise the
rule would look broken at the first `www` you meet. Narrowing to a path takes a slash, and a
star stands for any fragment.

Adding a rule **immediately moves matching tabs that are already open** and reports how many.

For realm hosts the rule is settled earlier - at the gate, before the first request goes out -
so the container picker clicks itself through.

## Context menus

| Where you right-click | Entry |
|---|---|
| a link | **Open link in container** |
| a tab in the tab strip | **Move tab to container** - moves the clicked tab |
| page content | **Move tab to container** - moves the current tab |
| the extension icon | the same, for the active tab |

Moving a tab also mounts that container session and reloads the page; without it you would
still see the previous account and the tab would shortly hit the gate as frozen. The reload
only happens when the host belongs to a realm.

The **tab strip** menu needs Chrome 149 or newer - earlier releases did not expose that context
to extensions. On older Chrome the entry is simply absent and the page and icon menus work
unchanged. Check your version at `chrome://version`.

## Backup and sync

Two mechanisms, and **neither asks you to set anything up**. No OAuth, no Google Cloud project,
no account to connect.

| Path | Carries | Runs |
|---|---|---|
| Chrome sync | containers, realms, rules, settings | automatically, on by default |
| File export | the above plus windows and tabs, cookies optional | when you press the button |

### Chrome sync

`chrome.storage.sync` carries the configuration over the account your Chrome profile is already
signed into. That is the mechanism Chrome provides for exactly this, and it needs nothing from
you: no credentials, no consent screen, no third party holding a key to your data.

It leaves out windows and tabs, which are specific to a machine, and cookies, which never leave
the device automatically. The shared copy is capped at 100 KB; a realistic configuration is
around 5 KB, and if a write ever fails the reason appears in settings rather than silently.

Conflicts resolve as last writer wins over the whole configuration.

### File export and import

**Settings > Backup & Sync > Export to JSON** saves containers, realms, rules and the window/tab
tree. Import merges configuration by `id` and optionally restores windows.

Put the file in a folder your cloud drive already syncs and you have an off-machine backup
without granting anything access to your account.

A separate toggle adds **cookies** to the file. It is off by default and should stay that way:
the file then holds live sign-in sessions in plain text, and anyone who gets it enters those
accounts without a password and without MFA.

### Why there is no cloud integration

An earlier version uploaded to Google Drive. It was removed, and the reasoning is worth keeping
because it applies to any cloud provider.

Every call to a provider API needs a client ID, and a client ID belongs to **someone**. There
are two models and no third:

1. **The extension ships one.** Users press Connect and nothing else, but every user then reaches
   the cloud through the maintainer project, under that quota and that responsibility.
2. **Each user registers their own.** Nobody else carries the risk, but setup moves into a
   console outside the extension, which is unreasonable to ask of anyone installing from a store.

For an extension meant to be published, neither is acceptable, and `chrome.storage.sync` covers
the part that actually matters - the configuration you cannot recreate from memory. Tabs and
windows are recoverable by hand and belong in an export file you control.

## Development

```bash
npm run dev        # esbuild in watch mode
npm run typecheck  # tsc --noEmit, strict
npm test           # host, cookie and rule matching tests
npm run icons      # regenerate icons from src/logo-webspaces.png
```

Icons are committed, so `npm run icons` is only needed when the logo changes. The logo is
glowing shapes on black; the script derives alpha from brightness so the toolbar icon is
transparent rather than a black tile.

Tests cover the trickiest part - matching cookies to realms. The critical case: `ESTSAUTH` sits
on `.microsoftonline.com`, which is **broader** than any host in the realm. Matching has to work
in both directions or the tenant session leaks despite the swap.

### Layout

```
src/shared/     types, host and rule matching, storage layer, message protocol
src/background/ vault - mount (switching) - gate (DNR) - tabs (container and group)
                snapshot (JSON) - sync (chrome.storage.sync) - index (wiring)
src/ui/         popup - options - frozen (container picker)
scripts/        icon generator, tests
docs/           architecture and design notes
```
