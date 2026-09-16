# 05 - Backup and sync

Two paths, and neither asks the user to configure anything.

| Path | Setup | Carries | Runs |
|---|---|---|---|
| Chrome sync | none | containers, realms, rules, settings | automatically, on by default |
| File export | none | the above plus windows and tabs, cookies optional | on a button press |

## Chrome sync

`chrome.storage.sync` carries the configuration over the account the profile is already signed
into. It is the mechanism Chrome provides for exactly this, and it needs no credentials, no
consent screen and no third party.

What it does not carry: windows and tabs (device specific, and they would not fit the quota),
and cookies (never automatically, anywhere).

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

## File export and import

Covers what sync leaves out: windows and tabs, and a file the user controls. Dropped into a
folder an existing cloud client already syncs, it becomes an off-machine backup without any
account integration.

Import merges configuration by `id`, so entries from the file overwrite existing ones with the
same id and everything else is kept. Restoring windows is optional and off by default.

A separate toggle adds cookies to the file. It is off by default and should stay that way.

Snapshot files record their format name and only `webspaces-snapshot` is accepted. There is no
migration path from earlier names, because no such file was ever produced outside development.

## Why there is no cloud integration

An earlier version uploaded to Google Drive. It was removed. The reasoning generalises to any
provider, so it is recorded here rather than rediscovered.

Every call to a provider API needs a client ID, and a client ID belongs to **someone**. There are
two models and no third:

1. **The extension ships one.** Users press Connect and nothing else. But then every user reaches
   the cloud through the maintainer project, under that quota and that responsibility, and the
   maintainer becomes the party users are granting access to.
2. **Each user registers their own.** Nobody else carries the risk, but setup moves into a
   console outside the extension. For something installed from a store that is not a setup flow,
   it is a barrier.

For a published extension neither is acceptable, and the trade buys little: `chrome.storage.sync`
already covers the configuration, which is the part that cannot be recreated from memory. Tabs
and windows are recoverable by hand and belong in an export file the user controls.

The attempt is worth knowing about in detail, because it looked reasonable at each step. Chasing
a client ID that could be pasted at runtime led from `getAuthToken` to `launchWebAuthFlow`, which
required a Web application client type, a client secret, a branding page, a publishing
requirement, PKCE and token refresh written by hand, and a bypass that opened the isolation gate
while the sign-in page was up. Each of those was a reasonable answer to the previous obstacle,
and the sum was indefensible.
