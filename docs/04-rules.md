# 04 - Opening rules

A rule says "always open this address in that container". It is a purely organisational layer,
independent of cookie isolation, and it applies to **every address** - not only realm hosts.

## Pattern semantics

```
example.com                  whole site including subdomains (also www.example.com)
https://example.com/         the same; scheme and trailing slash are stripped
admin.microsoft.com/*        narrowed to paths under that host
*.sharepoint.com             any SharePoint tenant
```

Two normalisations exist because of how people actually type patterns:

- **Scheme and trailing slash are stripped.** Patterns get pasted from the address bar, so
  `https://example.com/` has to mean the same as `example.com`. Without this the pattern is
  compared against `host + path` and never matches anything.
- **A bare host means the whole site.** Otherwise a rule on `example.com` misses
  `www.example.com`, which is the most common source of confusion. It still does not catch
  `notexample.com` or `example.com.evil.net`.

Narrowing to a path requires a slash. A star stands for any fragment.

## When rules are evaluated

| Situation | Path |
|---|---|
| navigation to a realm host | at the gate, before the first request - the picker clicks itself through |
| navigation to any other host | `webNavigation.onCommitted`, after the navigation lands |
| rule added or edited | immediately across all open tabs, reporting how many moved |
| browser start | during `bootstrap()` |

Applying rules to tabs that are **already open** matters: without it, adding a rule does nothing
visible until the next navigation, which reads as a broken feature.

## Ordering

The first enabled rule that matches wins. There is no specificity ranking - if two rules could
match the same address, the one earlier in the list decides.
