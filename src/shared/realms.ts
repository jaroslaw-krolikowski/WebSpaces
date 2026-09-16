import type { Realm, StoredCookie } from "./types";

/**
 * The query parameter the gate uses to carry the original address to the
 * container picker. It is appended last, so everything after it is the address.
 */
export const PENDING_PARAM = "__webspaces";

/** Whether a pattern ("example.com" or "*.example.com") covers a given host. */
export function hostMatchesPattern(pattern: string, host: string): boolean {
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p.startsWith("*.")) {
    const base = p.slice(2);
    return h === base || h.endsWith(`.${base}`);
  }
  return h === p;
}

/** The realm an address belongs to, or null when nobody cares about that host. */
export function realmForUrl(realms: Realm[], url: string): Realm | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  return realms.find((realm) => realm.hosts.some((p) => hostMatchesPattern(p, host))) ?? null;
}

/**
 * Domains for the requestDomains condition in DNR. Chrome matches the given
 * domain together with its subdomains, so the wildcard is simply trimmed.
 */
export function realmRequestDomains(realm: Realm): string[] {
  return [...new Set(realm.hosts.map((h) => (h.startsWith("*.") ? h.slice(2) : h)))];
}

/**
 * Whether a cookie on a given domain falls into a realm. Containment is checked
 * both ways: a cookie on ".microsoftonline.com" serves login.microsoftonline.com
 * (broader than the pattern), while a cookie on "login.microsoftonline.com" is
 * narrower than the pattern "*.microsoftonline.com". Both have to be caught,
 * otherwise ESTSAUTH leaks between containers.
 */
export function cookieBelongsToRealm(cookieDomain: string, realm: Realm): boolean {
  const d = cookieDomain.replace(/^\./, "").toLowerCase();
  return realm.hosts.some((pattern) => {
    const base = (pattern.startsWith("*.") ? pattern.slice(2) : pattern).toLowerCase();
    return d === base || d.endsWith(`.${base}`) || base.endsWith(`.${d}`);
  });
}

/** The URL the chrome.cookies API needs in order to write or remove a cookie. */
export function cookieUrl(cookie: Pick<StoredCookie, "domain" | "path" | "secure">): string {
  const host = cookie.domain.replace(/^\./, "");
  return `${cookie.secure ? "https" : "http"}://${host}${cookie.path}`;
}

export function toStored(cookie: chrome.cookies.Cookie): StoredCookie {
  const stored: StoredCookie = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    hostOnly: cookie.hostOnly,
    session: cookie.session,
  };
  if (cookie.expirationDate !== undefined) stored.expirationDate = cookie.expirationDate;
  if (cookie.partitionKey) stored.partitionKey = cookie.partitionKey;
  return stored;
}

export function toSetDetails(cookie: StoredCookie): chrome.cookies.SetDetails {
  const details: chrome.cookies.SetDetails = {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
  };
  // A host-only cookie is recognised by the ABSENCE of the domain field.
  // Passing it here would turn the cookie into a domain cookie visible to
  // every subdomain.
  if (!cookie.hostOnly) details.domain = cookie.domain;
  if (!cookie.session && cookie.expirationDate !== undefined) {
    details.expirationDate = cookie.expirationDate;
  }
  if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
  return details;
}

/**
 * Matches a rule pattern against an address.
 *
 * Patterns get pasted straight from the address bar, so they arrive with a
 * scheme and a trailing slash. Both are stripped, which makes
 * "https://example.com/" mean exactly the same as "example.com".
 *
 * A bare host with no path and no wildcard is treated as the whole site,
 * subdomains included. Otherwise a rule on "example.com" would miss
 * "www.example.com", which is the most common source of confusion.
 */
export function ruleMatches(pattern: string, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const cleaned = pattern
    .trim()
    .toLowerCase()
    .replace(/^[a-z*]+:\/\//, "")
    .replace(/\/+$/, "");
  if (!cleaned) return false;

  const host = parsed.hostname.toLowerCase();
  if (!cleaned.includes("/") && !cleaned.includes("*")) {
    return host === cleaned || host.endsWith(`.${cleaned}`);
  }

  const subject = `${host}${parsed.pathname}`.toLowerCase();
  const escaped = cleaned.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  // A pattern without a slash addresses the host, so any path under it matches.
  const body = cleaned.includes("/") ? escaped : `${escaped}(/.*)?`;
  return new RegExp(`^${body}$`).test(subject);
}

/**
 * Extracts the address the gate appended to the container picker URL.
 * The marker comes last, so everything after it is taken verbatim - including
 * the query string that belongs to the address itself, which URLSearchParams
 * would not hand back in one piece.
 */
export function carriedUrl(href: string): string | null {
  const marker = `?${PENDING_PARAM}=`;
  const index = href.indexOf(marker);
  if (index === -1) return null;
  const raw = href.slice(index + marker.length);
  return raw.startsWith("http") ? raw : null;
}
