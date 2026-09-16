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

Three paths, in order of how much they ask of you.

| Path | Setup | Carries | Good for |
|---|---|---|---|
| Chrome sync | none | containers, realms, rules, settings | the same setup on every machine |
| Google Drive | one registration | the above plus windows and tabs | a real file, history, full restore |
| File export | none | the above, cookies optional | moving between accounts, archiving |

### Chrome sync

**On by default and free of setup.** `chrome.storage.sync` carries the configuration over the
account your Chrome profile is already signed into - no OAuth, no Cloud project, no client ID.
For most people this is the whole answer.

It leaves out windows and tabs, which are specific to a machine, and cookies, which never leave
the device automatically. The shared copy is capped at 100 KB; a realistic configuration is
around 5 KB, and if a write ever fails the reason appears in settings rather than silently.

Conflicts resolve as last writer wins over the whole configuration.

### Google Drive backup

Adds what sync leaves out: windows and tabs, an actual file you can open and keep, and version
history. It uploads into a **`WebSpaces`** folder on the Drive of the signed-in account and
**never includes cookies** - the file lands in the cloud unattended, and sign-in sessions in
plain text would give anyone who takes over that Google account entry to every tenant without a
password and without MFA.

Authentication follows the
[official Chrome guide](https://developer.chrome.com/docs/extensions/how-to/integrate/oauth):
`chrome.identity.getAuthToken` with a **Chrome Extension** OAuth client. There is **no client
secret** and no sign-in page - Chrome holds the tokens itself. Two consequences worth knowing:
the isolation gate has nothing to intercept, and nothing lands in the cookie jar to pollute the
mounted container vault.

The one cost is that Chrome reads the client ID from the **manifest** and offers no way to hand
it one at runtime, so finishing the setup takes a rebuild. The panel hands you the exact command.

#### Why you register your own credentials

Google has no registration-free way into a Drive: every call needs a client ID, and a client ID
needs a Cloud Console project. WebSpaces ships no client ID of its own on purpose. Bundling one
would route every user through a single maintainer project, under that maintainer quota and that
maintainer responsibility. Registering your own takes five minutes once and keeps the access
yours.

If you use WebSpaces on more than one machine, run `npm run key` first. It pins the extension ID
so a single registration stays valid everywhere, instead of changing whenever the project folder
moves. Both key files are gitignored.

### Setup

**Do it in the settings page.** Open **Settings > Backup & Sync**. Every step carries a one line
reason, a button that opens the page it needs, and marks itself done as you go. The list below is
the same thing in text form.

1. Copy the **extension ID** shown in step 1.
2. In [Google Cloud Console](https://console.cloud.google.com) create a project.
3. Enable the **Google Drive API**.
4. Consent screen, three pages in order. **Branding**: app name, user support email, developer
   contact email. **Data access**: add the scope `https://www.googleapis.com/auth/drive.file`.
   **Audience**: set the user type, then press **Publish app**.
5. **Clients > Create**, application type **Chrome Extension**, paste the extension ID. No
   redirect URI and no secret are involved.
6. Paste the **client ID** into the panel, press Save, then run the command it gives you:
   `npm run client-id -- <client-id>`. Reload the extension at `chrome://extensions`.
7. Press **Connect and upload now** and accept the consent prompt.

**Publish the app, do not leave it in Testing.** In Testing the consent screen refuses every
account outside the test user list, which shows up as `Error 403: access_denied`, and consent
granted in Testing lapses after seven days. Publishing needs no review here: `drive.file` is a
[non-sensitive scope](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).
An unverified app warning on first consent is expected and harmless.

The `drive.file` scope is the narrowest available: the extension sees **only files it created
itself** and has no right to read the rest of your Drive. One side effect - a `WebSpaces` folder
you made by hand is invisible to it, so it will create its own.

**The ID of an extension loaded from a directory depends on that path.** Moving the project
changes the ID and breaks the OAuth binding. Run `npm run key` once to pin it, and a single
registration stays valid across moves and machines.

Backups overwrite the same file, so version history stays on the Drive side instead of piling
up dated copies. The alarm never prompts for consent on its own: if access lapses, the reason
shows up in settings and **Upload now** resumes.
## File export and import

**Settings > Backup & Sync > Export to JSON** saves containers, realms, rules and the window/tab
tree. Import merges configuration by `id` and optionally restores windows.

A separate toggle adds **cookies** to the file. It is off by default and should stay that way:
the file then holds live sign-in sessions in plain text.

## Development

```bash
npm run dev        # esbuild in watch mode
npm run typecheck  # tsc --noEmit, strict
npm test           # host, cookie and rule matching tests
npm run key        # pin the extension id, once per installation
```

Tests cover the trickiest part - matching cookies to realms. The critical case: `ESTSAUTH` sits
on `.microsoftonline.com`, which is **broader** than any host in the realm. Matching has to work
in both directions or the tenant session leaks despite the swap.

### Layout

```
src/shared/     types, host and rule matching, storage layer, message protocol
src/background/ vault - mount (switching) - gate (DNR) - tabs (container and group)
                snapshot (JSON) - drive + backup (Google Drive) - index (wiring)
src/ui/         popup - options - frozen (container picker)
scripts/        icon generator, tests
docs/           architecture and design notes
```
