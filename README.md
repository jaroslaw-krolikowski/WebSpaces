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
- **A blank new tab does not.** Ctrl+T gives you a tab outside every container, even when the tab
  you were on belongs to one, and it is moved out of the group if Chrome put it there. That is a
  fresh start, not following a link. Turn it off under **Behaviour** if you use the plus button at
  the end of a group to add tabs to that group.

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

**A container does not isolate every site you open in it.** Only the hosts listed in a realm get a
separate session; everything else shares one cookie jar, exactly as before you installed anything.

That is deliberate, and it is the trade-off the whole design turns on. Isolating a host means tabs
of other containers on that host get **frozen** while you are elsewhere. Isolate every site and
you can only use one container at a time in the entire browser, which is a worse version of
separate Chrome profiles. Isolate the hosts that actually collide and everything else keeps
working in parallel.

So realms are the dial. If a site matters, put it in one - the popup offers to do it for the site
you are on, in one click, and it lands in a realm of its own so the freezing stays narrow.

The bundled realms are **presets, not a closed list** - edit, delete, or add your own. A deleted
preset can be restored from the dropdown in settings.

| Preset | Shared sign-in surface |
|---|---|
| Microsoft 365 / Entra ID | `login.microsoftonline.com`, `*.cloud.microsoft`, `admin.microsoft.com`, `portal.azure.com` |
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
| `*.cloud.microsoft` | `contoso-my.sharepoint.com` |
| `id.atlassian.com` | `acme.atlassian.net` |
| `signin.aws.amazon.com` | `acme.awsapps.com` |

A host left out of every realm is not just unprotected, it is invisible: nothing is swapped and
nothing is frozen, so all containers share one session there. `*.cloud.microsoft` - the domain
Microsoft moved Outlook, Teams and the M365 app onto - was missing at first, which looked exactly
like sessions bleeding between groups. Existing installations get it added once, automatically;
hosts are only ever added, never removed.

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
| page content or the icon | **Bookmark page in container** - only while per-container bookmarks are on |

Moving a tab also mounts that container session and reloads the page; without it you would
still see the previous account and the tab would shortly hit the gate as frozen. The reload
only happens when the host belongs to a realm.

The **tab strip** menu needs Chrome 149 or newer - earlier releases did not expose that context
to extensions. On older Chrome the entry is simply absent and the page and icon menus work
unchanged. Check your version at `chrome://version`.

## Experimental: bookmarks per container

The bar shows only the bookmarks of the container you are in. Everything else parks in a folder
named `WebSpaces` under Other bookmarks. Chrome cannot filter what the bar displays, so entries
are physically moved; folders move whole and arrive intact.

Switching it on adopts your existing bar into **Default**, so nothing disappears. Bookmarks you
add later belong to whichever container is showing. Deleting a container sends its bookmarks back
to Default, or pins them to every bar, depending on the setting.

To save a page into a container that is **not** the one showing, right-click the page and use
**Bookmark page in container**. To hand an entry you already have to another container, use
**Settings > Experimental > Who owns what**. Both exist because Chrome exposes no `bookmark`
context to extensions and no way into the star button, so the choice cannot live where you would
expect it - on the bookmark itself.

One switch puts everything back. Details and the known costs are in
[docs/07-experimental.md](docs/07-experimental.md).

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

## Distribution

### On another machine

Pushing a version tag builds the extension on GitHub and attaches the zip to a release, so a
second machine needs neither a clone nor Node:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

Then download the zip from the releases page, unzip it, and load it unpacked. `dist/` is not
committed, so cloning the repository instead means `npm install && npm run build` first.

### Building the archive yourself

```bash
npm run package
```

Produces `release/webspaces-<version>.zip` with the manifest at the archive root. The same file
serves both purposes:

- **Install by hand.** Unzip it, then `chrome://extensions` → Developer mode → **Load unpacked**
  → pick the unzipped folder.
- **Publish.** Upload it in the Chrome Web Store developer dashboard.

**There is deliberately no `.crx`.** Chrome refuses to install a signed package that did not come
from the Web Store, failing with `CRX_REQUIRED_PROOF_MISSING`, so a `.crx` would only waste the
time of whoever downloaded it. Sideloading a `.crx` works only through enterprise policy, which
is a different deployment story.

### Publishing

Everything the Chrome Web Store asks for is written out in
[docs/08-webstore.md](docs/08-webstore.md): listing copy in English and Polish, the single purpose
statement, a justification per permission, the privacy tab answers and a screenshot shot list. The
published privacy policy is [PRIVACY.md](PRIVACY.md).

## Languages

The interface ships in English and Polish. Chrome picks by browser language; there is no switch,
because `chrome.i18n` is bound to the browser UI language. Adding a language means one file under
`_locales/`, and a key left out simply falls back to English.

## Development

```bash
npm run dev        # esbuild in watch mode
npm run typecheck  # tsc --noEmit, strict
npm test           # matching tests, element ids, CSS classes, message keys
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
