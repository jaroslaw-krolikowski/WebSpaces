# Privacy policy for WebSpaces

Last updated: 2026-09-17

## The short version

WebSpaces has no server, no account and no analytics. Nothing it reads is sent anywhere. The
author cannot see your data, because there is nowhere for it to arrive.

## What the extension stores, and where

Everything lives in your own browser profile, through the storage APIs Chrome provides to
extensions.

| What | Where | Leaves the device |
|---|---|---|
| Containers, opening rules, realms, settings | `chrome.storage.sync` | only through Chrome sync, to your own signed-in profiles |
| Cookies saved per container (the vault) | `chrome.storage.local` | never automatically |
| Which container each tab belongs to | `chrome.storage.session` | never, cleared when Chrome closes |
| Bookmark ownership, when the experimental feature is on | `chrome.storage.local` | never |

Chrome sync is the mechanism built into your browser. It carries the configuration to the Chrome
profiles you are signed into with your own Google account, under Google's terms for Chrome sync,
and the author has no access to it. It can be switched off in **Settings > Backup & Sync**.

**Cookies are never included in sync.** They stay on the device.

## Cookies

The extension exists to keep sign-in sessions apart, so it reads and writes cookies for the hosts
you list in a realm. A cookie moved out of the browser jar is kept in local extension storage
until you switch back to that container, then moved back. This is the whole mechanism.

The vault is **not encrypted**. Anyone with access to your Chrome profile can read it, in much the
same way they could read Chrome's own cookie database. Treat the profile as the security boundary.

## The export file

**Settings > Backup & Sync > Export to JSON** writes a file to wherever you choose. It contains
containers, realms, rules and your window and tab list.

A separate switch, off by default, adds cookies to that file. With it on, the file holds live
sign-in sessions in plain text, and anyone who obtains it can enter those accounts without a
password and without multi-factor authentication. The extension asks for confirmation and states
this before writing such a file. Where that file then goes is entirely your decision.

## What is never collected

- No analytics, telemetry, crash reporting or usage statistics
- No browsing history, page content or form data
- No personal identifiers, email addresses or account names
- No advertising identifiers, and no data sold or shared with anyone

## Permissions and why each one exists

| Permission | Why |
|---|---|
| `cookies` | reading and writing session cookies for realm hosts is the core function |
| `tabs`, `tabGroups` | a container is a Chrome tab group; the extension has to read and set group membership |
| `declarativeNetRequest` | the gate that blocks requests from a tab whose container is not mounted |
| `storage`, `unlimitedStorage` | keeping the configuration and the cookie vault locally |
| `browsingData` | clearing localStorage and IndexedDB for realm hosts when switching, because Microsoft portals keep access tokens there rather than in cookies |
| `webNavigation` | applying opening rules when a navigation lands |
| `contextMenus` | the right-click entries for opening, moving and bookmarking into a container |
| `bookmarks` | only used by the experimental per-container bookmarks feature, which is off by default |
| `<all_urls>` | realms are user-defined, so the hosts to gate and swap cookies for are not known in advance; the extension acts only on hosts you list |

## Children

The extension is not directed at children and collects nothing from anyone.

## Changes

Any change to this policy will be published in this file in the repository, with the date above
updated. The history of the file is public.

## Contact

Jaroslaw Krolikowski - https://jaroslawkrolikowski.pl

Issues: https://github.com/jaroslaw-krolikowski/WebSpaces/issues
