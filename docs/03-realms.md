# 03 - Realms

A realm is a set of hosts whose cookies collide between containers. It is the single most
consequential choice in the project, because it decides how many tabs get frozen.

## The rule

**Only hosts shared across organisations belong in a realm.** Those are the only places where
cookies actually collide. Hosts whose name carries the organisation stay out.

| In the realm | Outside the realm | Why |
|---|---|---|
| `login.microsoftonline.com` | `contoso.sharepoint.com` | the host names the tenant |
| `id.atlassian.com` | `acme.atlassian.net` | the instance names the organisation |
| `signin.aws.amazon.com` | `acme.awsapps.com` | the subdomain names the organisation |

The payoff is concrete: two Jira instances from different companies run side by side, because
their hosts never overlap. Only the shared sign-in screen needs a container switch.

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

## Deleting a realm

Order matters. The mounted session is handed back to the default container **before** the realm
is removed; otherwise those cookies would stay in the browser permanently with no vault left to
remember them. Vault slots for the realm are dropped afterwards.

## Empty states

A realm with no hosts is harmless and simply does nothing. No realms at all means containers
are purely organisational labels on tab groups.
