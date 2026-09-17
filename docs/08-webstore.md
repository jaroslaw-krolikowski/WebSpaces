# 08 - Chrome Web Store submission

Everything the store asks for, written out so submission is copying rather than composing. What
only the account holder can do is marked **you**; the rest is in the repository already.

## Before you publish

| Step | State |
|---|---|
| Register the developer account, pay the one-off fee | **you** - https://chromewebstore.google.com/developer/dashboard |
| Developer email, monitored and permanent | **you** - it cannot be changed after the account exists |
| Prepare the extension package | `npm run package` |
| Store listing copy | below, English and Polish |
| Privacy policy at a public URL | `PRIVACY.md`, link below |
| Privacy tab answers, single purpose, permission justifications | below |
| Screenshots | **you** - the shot list is below, the extension has to be running |

The email address is permanent and receives every review notice and takedown warning, so it is
worth using one that will outlive the project rather than a personal inbox.

## Package

```bash
npm run package
```

Produces `release/webspaces-<version>.zip` with the manifest at the archive root, which is what the
dashboard expects. No `.crx`: Chrome refuses a signed package that did not come from the store.

Version numbers only go up, and a number once published cannot be reused. Bump `manifest.json`
before each upload.

## Listing copy

### Name

```
WebSpaces
```

### Summary (132 characters maximum)

English, 118 characters:

```
Container tabs for Chrome, built on native tab groups. A separate cookie vault per container, for two tenants at once.
```

Polish, 122 characters:

```
Karty kontenerowe dla Chrome oparte na grupach kart. Osobny sejf ciasteczek w kazdym kontenerze, dla dwoch dzierzaw naraz.
```

### Description

```
WebSpaces gives Chrome the container tabs Firefox has, built on the tab groups Chrome already
has. A container is a tab group with its own cookie vault.

It exists for one concrete problem. Microsoft SSO has no per-organisation endpoint: every tenant
signs in through login.microsoftonline.com, so the session cookies collide and you cannot stay
signed into two tenants at once. The same applies to Atlassian, Google, AWS and GitHub, which
ship as editable presets.

WHAT IT DOES

- A cookie vault per container, swapped when you switch
- Rules that always open an address in a chosen container, applied to tabs already open
- Right-click a link, a tab or a page to send it to a container
- Editable isolation realms, so you decide which hosts collide
- Configuration carried between your Chrome profiles by Chrome sync, with nothing to set up
- Export to a JSON file, including windows and tabs
- Experimental: a separate bookmarks bar per container

WHAT IT DOES NOT DO

Isolation is sequential, not parallel. One container per realm at a time: a tab of another
container is frozen at the network layer rather than quietly running on the wrong account. That
is a limit of the Chrome extension APIs, not of this extension, and it is stated plainly instead
of being hidden.

It is not an anti-detect tool. IP address, fingerprint and history stay shared, exactly as in
Firefox containers.

PRIVACY

No server, no account, no analytics. Nothing leaves your device unless you export a file
yourself. The source is public: github.com/jaroslaw-krolikowski/WebSpaces
```

### Category

Workflow & Planning. Secondary reading would be Developer Tools, but the audience is people
juggling several organisations, not developers specifically.

### Language

English, with Polish supplied through `_locales`. The store picks up the manifest name and
description per locale on its own.

## Single purpose

The store requires one sentence, and a narrow one:

```
WebSpaces keeps browser sessions separate by binding a cookie vault to each Chrome tab group,
so several accounts on the same site can be used one at a time without signing out.
```

## Permission justifications

Each field takes a short answer. These are the ones to paste.

| Permission | Justification |
|---|---|
| `cookies` | Reading and writing session cookies for the hosts the user lists in a realm is the core function: a container's cookies are moved out of the browser jar when it is not in use and back in when it is. |
| `tabs` | A container is a Chrome tab group, so the extension has to read which tab belongs to which group, move tabs between groups, and reload a tab after its session changes. |
| `tabGroups` | Containers are native tab groups. The extension reads and sets group titles and colours so a group created in Chrome and a container in the extension stay one thing. |
| `declarativeNetRequest` | A tab belonging to a container whose session is not currently loaded is blocked at the network layer. Without it the tab would keep polling with another account's cookies and invalidate that session. |
| `storage` | Stores the configuration and the per-container cookie vault locally. |
| `unlimitedStorage` | A vault holding cookies for several containers and realms can exceed the default 10 MB quota, and losing it means losing every saved session. |
| `browsingData` | Microsoft 365 portals keep access tokens in localStorage, not cookies. Switching containers clears localStorage and IndexedDB for realm hosts only, otherwise a tab keeps working on the previous tenant's token for about an hour. |
| `webNavigation` | Applies the user's opening rules when a navigation commits, so an address opens in the container the user assigned to it. |
| `contextMenus` | Adds the right-click entries that open a link in a container, move a tab to a container, and bookmark a page into a container. |
| `bookmarks` | Used only by the optional per-container bookmarks bar, which is off by default and reversible with one switch. |
| `<all_urls>` host access | Realms are defined by the user, so the hosts needing a cookie swap and a network gate are not known at build time. The extension acts only on hosts the user has listed. |

## Privacy tab answers

- **Does it collect personally identifiable information?** No.
- **Health information?** No.
- **Financial and payment information?** No.
- **Authentication information?** **Yes.** Cookies, including session cookies, stored locally so
  containers can be switched. Never transmitted.
- **Personal communications, location, web history, user activity?** No.
- **Website content?** No.
- **Privacy policy URL:** https://github.com/jaroslaw-krolikowski/WebSpaces/blob/main/PRIVACY.md
- **Certifications:** the data is not sold or transferred to third parties, is not used for any
  purpose unrelated to the single purpose, and is not used to determine creditworthiness.

The authentication answer has to be yes. Saying no while the extension holds session cookies is
the kind of mismatch that gets an item removed, and the mechanism is the whole point of it.

## Assets

| Asset | Size | State |
|---|---|---|
| Store icon | 128x128 | `public/icons/icon128.png` |
| Screenshots | 1280x800 or 640x400, 1 to 5, square corners, no padding | **you** |
| Small promo tile | 440x280 | optional |
| Marquee | 1400x560 | optional, only for carousel consideration |

### Shot list

Five screenshots, in this order, each one making a point rather than showing a screen:

1. **Containers panel** with three or four containers, one per organisation, colours differing -
   this is the one that has to say what the extension is in a second.
2. **The container picker** on a login.microsoftonline.com address, so the Firefox-style prompt
   is visible.
3. **Right-click menu** open on a tab, showing the container submenu.
4. **Opening rules** with a couple of realistic patterns.
5. **Backup & Sync**, which answers "where does my data go" before anyone asks.

Take them at 1280x800 with the browser window sized so nothing is cut. No personal tenant names,
no real email addresses, no visible account pictures - a reviewer sees these and so does everyone
else.

## After submission

Review usually takes a few days and can ask for changes. The common causes of a rejection here
would be:

- **Broad host access.** `<all_urls>` is justified above; if the reviewer pushes back, the answer
  is that realms are user-defined, not that the extension needs every site.
- **The authentication data answer.** Disclosed, see above.
- **Single purpose.** The bookmarks feature is the one thing that could read as a second purpose.
  It is off by default and serves the same separation of identities, which is the line to take.
