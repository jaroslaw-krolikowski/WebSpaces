// Tests for host, cookie and rule matching. They run straight against the TS
// sources — Node strips the types itself. This module touches no chrome.* API,
// so it can be verified outside the browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  carriedUrl,
  cookieBelongsToRealm,
  cookieUrl,
  hostMatchesPattern,
  realmForUrl,
  ruleMatches,
  toSetDetails,
} from "../src/shared/realms.ts";
import { BUILTIN_REALMS } from "../src/shared/types.ts";

const microsoft = BUILTIN_REALMS.find((r) => r.id === "microsoft");
const google = BUILTIN_REALMS.find((r) => r.id === "google");
const atlassian = BUILTIN_REALMS.find((r) => r.id === "atlassian");
const aws = BUILTIN_REALMS.find((r) => r.id === "aws");

test("a wildcard pattern covers the base domain and its subdomains", () => {
  assert.equal(hostMatchesPattern("*.office.com", "outlook.office.com"), true);
  assert.equal(hostMatchesPattern("*.office.com", "office.com"), true);
  assert.equal(hostMatchesPattern("*.office.com", "office.com.evil.net"), false);
});

test("a pattern without a wildcard does not catch lookalike hosts", () => {
  assert.equal(hostMatchesPattern("login.microsoftonline.com", "login.microsoftonline.com"), true);
  assert.equal(
    hostMatchesPattern("login.microsoftonline.com", "evil-login.microsoftonline.com"),
    false,
  );
  assert.equal(
    hostMatchesPattern("login.microsoftonline.com", "sub.login.microsoftonline.com"),
    false,
  );
});

test("a broad SSO cookie is caught by the realm", () => {
  // The critical case: ESTSAUTH sits on ".microsoftonline.com", which is BROADER
  // than any host in the realm. If this failed, a tenant session would leak
  // between containers despite the swap.
  assert.equal(cookieBelongsToRealm(".microsoftonline.com", microsoft), true);
  assert.equal(cookieBelongsToRealm("login.microsoftonline.com", microsoft), true);
  assert.equal(cookieBelongsToRealm(".login.microsoftonline.com", microsoft), true);
});

test("hosts outside a realm are left alone", () => {
  // SharePoint is deliberately outside the realm: the host carries the tenant
  // name, so nothing collides and those tabs should run in parallel.
  assert.equal(cookieBelongsToRealm(".sharepoint.com", microsoft), false);
  assert.equal(cookieBelongsToRealm("contoso.sharepoint.com", microsoft), false);
  assert.equal(cookieBelongsToRealm("example.com", microsoft), false);
});

test("realms do not overlap", () => {
  assert.equal(
    realmForUrl(BUILTIN_REALMS, "https://login.microsoftonline.com/common")?.id,
    "microsoft",
  );
  assert.equal(realmForUrl(BUILTIN_REALMS, "https://accounts.google.com/signin")?.id, "google");
  assert.equal(realmForUrl(BUILTIN_REALMS, "https://contoso.sharepoint.com/sites/x"), null);
  assert.equal(realmForUrl(BUILTIN_REALMS, "not-an-address"), null);
  assert.ok(google);
});

test("presets follow the rule: only hosts shared across organisations", () => {
  // Atlassian: sign-in is shared, the instance is not.
  assert.equal(cookieBelongsToRealm("id.atlassian.com", atlassian), true);
  assert.equal(cookieBelongsToRealm(".atlassian.com", atlassian), true);
  assert.equal(cookieBelongsToRealm("acme.atlassian.net", atlassian), false);
  assert.equal(realmForUrl(BUILTIN_REALMS, "https://id.atlassian.com/login")?.id, "atlassian");
  assert.equal(realmForUrl(BUILTIN_REALMS, "https://acme.atlassian.net/jira"), null);

  // AWS: the sign-in screen and the console are shared, an org SSO portal is not.
  assert.equal(cookieBelongsToRealm("signin.aws.amazon.com", aws), true);
  assert.equal(cookieBelongsToRealm("acme.awsapps.com", aws), false);
  assert.equal(
    realmForUrl(BUILTIN_REALMS, "https://eu-west-1.console.aws.amazon.com/ec2")?.id,
    "aws",
  );
});

test("opening rules match host and path", () => {
  assert.equal(ruleMatches("*.sharepoint.com", "https://contoso.sharepoint.com/sites/x"), true);
  assert.equal(ruleMatches("admin.microsoft.com", "https://admin.microsoft.com/"), true);
  assert.equal(ruleMatches("admin.microsoft.com/*", "https://admin.microsoft.com/users"), true);
  assert.equal(ruleMatches("admin.microsoft.com", "https://notadmin.microsoft.com/"), false);
});

test("a pattern pasted from the address bar behaves like a bare host", () => {
  // This exact case used to fail: a pattern with a scheme and a trailing slash
  // had no chance of matching against "host + path".
  const pasted = "https://example.org/";
  assert.equal(ruleMatches(pasted, "https://example.org/"), true);
  assert.equal(ruleMatches(pasted, "https://example.org/blog/post"), true);
  assert.equal(ruleMatches(pasted, "http://example.org"), true);
});

test("a bare host covers the whole site including subdomains", () => {
  assert.equal(ruleMatches("example.org", "https://www.example.org/"), true);
  assert.equal(ruleMatches("example.com", "https://blog.example.com/a"), true);
  // But it must not catch hosts that merely look similar.
  assert.equal(ruleMatches("example.com", "https://notexample.com/"), false);
  assert.equal(ruleMatches("example.com", "https://example.com.evil.net/"), false);
});

test("the picker reads the address the gate appended", () => {
  const page = "chrome-extension://abcdef/ui/frozen.html";
  // Sign-in addresses carry query strings of their own, so everything after the
  // marker belongs to the address and URLSearchParams would cut it in the wrong place.
  const target = "https://login.microsoftonline.com/common/oauth2/authorize?client_id=x&y=z";
  assert.equal(carriedUrl(`${page}?__webspaces=${target}`), target);
  assert.equal(carriedUrl(`${page}?__webspaces=https://example.com/`), "https://example.com/");

  // A missing marker or junk instead of an address must not pose as a target.
  assert.equal(carriedUrl(page), null);
  assert.equal(carriedUrl(`${page}?__webspaces=`), null);
  assert.equal(carriedUrl(`${page}?__webspaces=javascript:alert(1)`), null);
});

test("a host-only cookie is written without the domain field", () => {
  // Passing domain would turn a host-only cookie into a domain cookie visible
  // to every subdomain — exactly the leak we are preventing.
  const hostOnly = toSetDetails({
    name: "ESTSAUTH",
    value: "x",
    domain: "login.microsoftonline.com",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "no_restriction",
    hostOnly: true,
    session: true,
  });
  assert.equal(hostOnly.domain, undefined);
  assert.equal(hostOnly.url, "https://login.microsoftonline.com/");
  assert.equal(hostOnly.expirationDate, undefined);

  const domainWide = toSetDetails({
    name: "buid",
    value: "y",
    domain: ".microsoftonline.com",
    path: "/",
    secure: true,
    httpOnly: false,
    sameSite: "lax",
    hostOnly: false,
    session: false,
    expirationDate: 1893456000,
  });
  assert.equal(domainWide.domain, ".microsoftonline.com");
  assert.equal(domainWide.expirationDate, 1893456000);
});

test("the cookie URL respects the secure flag", () => {
  assert.equal(
    cookieUrl({ domain: ".example.com", path: "/a", secure: true }),
    "https://example.com/a",
  );
  assert.equal(cookieUrl({ domain: "example.com", path: "/", secure: false }), "http://example.com/");
});
