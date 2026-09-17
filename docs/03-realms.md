# 03 - Realms

A realm is a set of hosts whose cookies collide between containers. It is the single most
consequential choice in the project, because it decides how many tabs get frozen.

## What people expect, and what happens

The expectation is reasonable: put a site in a container and it gets its own session. That is how
Firefox behaves, because Firefox isolates in the engine and every container runs in parallel.

Here, **only hosts listed in a realm are isolated**. Everything else shares one cookie jar across
all containers. The reason is that Chrome offers no per-tab cookie store, so isolation means
swapping the jar, and swapping means every tab of a non-mounted container has to be frozen or it
will rotate the mounted session underneath you.

Isolating everything would therefore freeze everything: one container at a time across the whole
browser, with a full-jar swap on every switch - tens of thousands of `chrome.cookies.set` calls,
seconds of work, and one failure away from losing sessions. Separate Chrome profiles do that job
better.

So the realm list is the dial between the two. A host in a realm is isolated and its tabs
elsewhere freeze; a host outside every realm is shared and never freezes. Deciding which hosts go
in is the user's call, and the popup offers to add the site in view as its own realm so the cost
stays confined to that one host.

## The rule

**Only hosts shared across organisations belong in a realm.** Those are the only places where
cookies actually collide. Hosts whose name carries the organisation stay out.

| In the realm | Outside the realm | Why |
|---|---|---|
| `login.microsoftonline.com` | `contoso.sharepoint.com` | the host names the tenant |
| `*.cloud.microsoft` | `contoso-my.sharepoint.com` | every tenant lands on the same origin |
| `id.atlassian.com` | `acme.atlassian.net` | the instance names the organisation |
| `signin.aws.amazon.com` | `acme.awsapps.com` | the subdomain names the organisation |

The payoff is concrete: two Jira instances from different companies run side by side, because
their hosts never overlap. Only the shared sign-in screen needs a container switch.

### The cost of missing one

`*.cloud.microsoft` was absent from the Microsoft preset for a while, and it is worth keeping the
symptom on record because every future gap will look the same. Microsoft consolidated its
user-facing apps onto that one domain - `m365.cloud.microsoft`, `outlook.cloud.microsoft`,
`teams.cloud.microsoft` - with no tenant anywhere in the host.

A host outside every realm is not merely unprotected, it is **invisible**: its cookies are never
swapped and its tabs are never frozen, so every container quietly shares one session there. What
the user sees is sessions bleeding between groups on exactly the pages they spend the day in,
while the sign-in screen behaves perfectly.

A realm missing a host fails silently, in the direction of leaking. That asymmetry is the reason
to err towards listing a shared host.

## Wildcards and concrete hosts

A wildcard covers matching and gating, but `chrome.browsingData` needs **concrete origins** and
skips anything starting with `*.`. So a realm that relies on a wildcard gates the traffic and
swaps the cookies, yet never clears the `localStorage` where MSAL keeps access tokens.

That is why the Microsoft preset lists `*.cloud.microsoft` **and** the individual app hosts. The
wildcard catches everything; the spelled-out hosts are what actually gets cleared on a switch.

**Narrower realm, fewer frozen tabs.** That is the whole trade-off.

## Matching

Cookie-to-realm matching checks containment **in both directions**, and this is the part most
likely to be got wrong:

- `ESTSAUTH` lives on `.microsoftonline.com`, which is **broader** than any host listed.
- A cookie on `login.microsoftonline.com` is **narrower** than a pattern `*.microsoftonline.com`.

Both must match, or a tenant session leaks between containers despite the swap. There is a test
for exactly this in `scripts/test-matching.mjs`.

## Presets

Presets are a starting point, not a closed list. Every one can be edited, renamed or deleted,
and a deleted preset can be restored from the dropdown under its original id.

The `seeded` flag in state exists so that deleting **every** realm does not resurrect the
presets on the next read. Do not remove it.

### When a preset gains a host later

`seeded` also means an existing installation never learns about a preset that was incomplete, and
`*.cloud.microsoft` showed what that costs. `src/background/migrate.ts` closes the gap on a
one-way street:

- hosts are **added** only, never removed or reordered
- only to a realm still present and still carrying its `builtin` flag
- a realm the user deleted stays deleted
- the step is recorded per device, so a host deleted afterwards does not come back

Add a new step id rather than editing an old one. Reusing an id would re-run the addition against
people who have already made their own decision about those hosts.

## Deleting a realm

Order matters. The mounted session is handed back to the default container **before** the realm
is removed; otherwise those cookies would stay in the browser permanently with no vault left to
remember them. Vault slots for the realm are dropped afterwards.

## Empty states

A realm with no hosts is harmless and simply does nothing. No realms at all means containers
are purely organisational labels on tab groups.
