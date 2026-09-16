# 02 - Isolation

## The platform box

Three verified constraints define the whole design:

1. Chrome has **no per-tab cookie store**. `chrome.cookies` does not support partitioning.
2. `declarativeNetRequest` **cannot modify the `Cookie` header**. The rule validates, throws
   nothing, and the original header is sent
   ([crbug 40825809](https://issues.chromium.org/issues/40825809)).
3. MV3 removed blocking `webRequest`, and MV2 left the Web Store on 2026-08-31.

So the only mechanism is swapping cookies at switch time. That makes isolation **sequential**:
one container per realm at a time.

## Why swapping alone is not enough

A tenant tab left in the background keeps polling. With cookies swapped underneath it, those
requests carry the **mounted** tenant credentials and rotate its `ESTSAUTH`, quietly breaking
both sessions. Naive cookie swapping is therefore not merely limited - it is unsafe.

## The gate

Per realm, rebuilt from scratch on every change:

| Priority | Action | Condition |
|---|---|---|
| 1 | redirect to the picker | `main_frame` on realm hosts, any tab |
| 2 | allow | tabs of the mounted container, every resource type |
| 2 | allow | `tabIds: [-1]`, requests with no tab |
| 3 | block | tabs of a non-mounted container, everything but `main_frame` |

Layer 3 is the safety property: a foreign-container tab cannot send a single subresource.
Layer 1 doubles as the Firefox-style container prompt.

### Carrying the address

The redirect uses a regex substitution so the picker receives the original address in its own
`location`, rather than depending on the service worker having stored it first. If Chrome ever
rejects that rule, `refreshGate` falls back to a plain `extensionPath` redirect and logs why -
a gate without the address beats no gate at all.

### Requests with no tab

Downloads handed to the download manager and fetches from a page service worker have
`tabId = -1`. They cannot be attributed to a container, so they are allowed deliberately.
Blocking them breaks downloads while buying no isolation: the container decision was already
made when the navigation happened.

## Site data, not just cookies

M365 portals are MSAL applications and keep **access tokens in `localStorage`**. Swapping
cookies switches who you are signed in as, but a tab could keep using a cached token of the
previous tenant for roughly an hour. Every mount therefore clears `localStorage`, `indexedDB`
and `cacheStorage` for the realm origins. Wildcard hosts are skipped because `browsingData`
needs concrete origins.

## What stays out of reach

- **Parallel isolation.** Needs separate Chrome profiles and a native messaging host.
- **Fingerprint, IP, history.** Shared, exactly as in Firefox containers.
- **Vault encryption.** The vault sits in `chrome.storage.local` in the clear, on the same
  footing as the browser cookie database.
