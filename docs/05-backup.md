# 05 — Backup

Two independent paths: automatic upload to Google Drive, and manual file export/import.

## What goes into a backup

| Content | Drive | File export |
|---|---|---|
| containers, realms, rules | yes | yes |
| windows and tabs | yes | yes |
| cookies | **never** | only behind an explicit opt-in |

The Drive copy excludes cookies deliberately. It lands in the cloud automatically and
unattended, and sign-in sessions in plain text would give anyone who takes over that Google
account entry to every tenant without a password and without MFA. Sessions can be recreated by
signing in; the configuration cannot be recreated at all.

## Google Drive

Authentication uses `chrome.identity.getAuthToken`, an internal browser mechanism rather than a
sign-in page. Two consequences that matter here:

- the DNR gate has nothing to intercept, so the sign-in cannot be blocked by our own rules;
- nothing lands in the cookie jar, so the mounted container vault stays clean.

The scope is `https://www.googleapis.com/auth/drive.file` — the narrowest available. The
extension sees only files it created itself. A side effect: a `WebSpaces` folder made by hand is
invisible to it and it will create its own.

Uploads overwrite the same file, so version history stays on the Drive side instead of piling
up dated copies. The alarm runs non-interactively: if consent expires, the reason is stored in
`backup.lastError` and shown in settings, and **Upload now** resumes it.

### Setup summary

The client id is injected at build time from `google-client-id.txt` or `GOOGLE_CLIENT_ID`, never
committed. Without it the extension works normally and the backup section is greyed out with an
explanation instead of failing silently. Full steps are in `README.md`.

**The extension id depends on the directory path** when loaded unpacked. Relocating the project
breaks the OAuth binding and it has to be updated in Google Cloud.

## File export and import

Import merges configuration by `id`, so entries from the file overwrite existing ones with the
same id and everything else is kept. Restoring windows is optional and off by default.

Snapshot files record their format name. Files written under the earlier project names
(`tenantlock-snapshot`, `omnitab-snapshot`) are still accepted on import.
