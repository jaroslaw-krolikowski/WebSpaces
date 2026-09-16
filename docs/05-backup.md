# 05 - Backup and sync

Three independent paths, in order of how much they ask of you.

| Path | Setup | Carries | Good for |
|---|---|---|---|
| Chrome sync | none | containers, realms, rules, settings | the same setup on every machine |
| Google Drive | one registration | the above plus windows and tabs | a real file, history, full restore |
| File export | none | the above, cookies optional | moving between accounts, archiving |

## Chrome sync

`chrome.storage.sync` carries the configuration over the account the profile is already signed
into. No OAuth, no Cloud project, no client ID. It is on by default and is the answer for
almost everyone.

What it does not carry: windows and tabs (device specific, and they would not fit), and cookies
(same reason they stay out of the Drive backup).

Quotas are 100 KB in total and 8 KB per item, so the payload is chunked across several keys. A
realistic configuration is around 5 KB, which leaves a wide margin; if someone pastes a very
long host list the write fails and the reason is shown in settings rather than swallowed.

Two details worth knowing when changing this code:

- **Conflict resolution is last writer wins** over the whole payload. Per-field merging would
  need per-field timestamps for very little gain in a personal tool.
- **A device must not re-publish what it just received.** `pushToSync` compares the assembled
  payload with what is already stored and returns early when they match. Without that, applying
  a remote change writes local state, which triggers a push, which the other device applies, and
  the two bounce the same configuration back and forth forever. The writer id in the metadata
  guards the same loop within one device.

## Google Drive

Adds what sync leaves out: windows and tabs, an actual file, and version history on the Drive
side. It uploads into a `WebSpaces` folder on the Drive of the signed-in account and **never
includes cookies** - the file lands in the cloud unattended, and sessions in plain text would
open every tenant to anyone who takes over that Google account.

Authentication uses `chrome.identity.getAuthToken`, an internal browser mechanism rather than a
sign-in page. Two consequences that matter here:

- the DNR gate has nothing to intercept, so the sign-in cannot be blocked by our own rules;
- nothing lands in the cookie jar, so the mounted container vault stays clean.

The scope is `https://www.googleapis.com/auth/drive.file`, the narrowest available: the
extension sees only files it created itself. A side effect is that a `WebSpaces` folder made by
hand is invisible to it and it will create its own.

Uploads overwrite the same file, so history stays on the Drive side instead of piling up dated
copies. The alarm runs non-interactively: if consent expires, the reason is stored in
`backup.lastError` and shown in settings, and Upload now resumes it.

### Why there is no bundled client ID

Google offers no registration-free path to a Drive. Every call needs a client ID, and a client
ID needs a Cloud Console project. That leaves two models, and this project deliberately picked
the second:

1. Ship one client ID with the extension. Users click Connect and nothing else. But then every
   user reaches Drive through the maintainer project, under the maintainer quota and the
   maintainer responsibility.
2. **Each person registers their own.** Five minutes once, and the access belongs to whoever
   set it up.

The settings page walks through model 2 step by step, so the cost is a guided five minutes
rather than a documentation hunt.

### Why launchWebAuthFlow rather than getAuthToken

`chrome.identity.getAuthToken` is the tidier API: no sign-in page, nothing written to the cookie
jar, and Chrome manages the token. It reads the client ID from the **manifest**, though, which
means credentials can only arrive at build time. Asking every user to edit a file and rebuild is
not a setup flow.

`launchWebAuthFlow` lets us build the authorisation URL ourselves, so the client ID and secret
live in storage and can be pasted into the panel. The price is real and is handled explicitly:

- **It opens a genuine Google sign-in page**, which sits on a realm host. `setAuthBypass` lifts
  the gate for the few seconds the consent window is open, always inside a `finally`, otherwise
  our own redirect would send the consent page to the container picker.
- **The sign-in writes Google cookies into the mounted container.** The panel says so rather
  than silently reshuffling containers behind the user. It does not matter afterwards, since the
  refresh token is what keeps uploads working.
- **We manage tokens ourselves**: authorisation code with PKCE, a stored refresh token, and an
  access token refreshed a minute before expiry.

The OAuth client is therefore a **Web application** type with
`https://<extension-id>.chromiumapp.org/` as the redirect URI, not the Chrome Extension type.
Google requires a client secret at the token endpoint for that client type. For an installed
application that secret identifies the project rather than protecting it, which is why it is
acceptable to keep it in local storage - but it is still kept out of the sync payload, out of
the backup file and out of the repository.

### Setup progress

Steps two to five happen inside Google Cloud and cannot be observed from the extension, so the
click that opens each page is what advances the list. Steps six and seven advance on real state:
credentials saved, and a refresh token held. Progress only moves forward, so clicking a step
again never walks it back.

### Pinning the extension ID

An unpacked extension derives its ID from the directory path, so the ID changes when the folder
moves and differs on another machine, which would invalidate the registration each time.
`npm run key` generates a key pair once and the build injects the public half into the manifest,
fixing the ID for good. Both key files are gitignored: the public half is harmless, the private
half is what proves ownership, and neither belongs in a shared repository.

## File export and import

Import merges configuration by `id`, so entries from the file overwrite existing ones with the
same id and everything else is kept. Restoring windows is optional and off by default.

A separate toggle adds cookies to the file. It is off by default and should stay that way.

Snapshot files record their format name and only `webspaces-snapshot` is accepted. There is no
migration path from earlier names, because no such file was ever produced outside development.
