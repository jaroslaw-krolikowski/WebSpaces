# 07 - Experimental

Features that rearrange user data rather than only reading it. They live behind their own tab
because the failure mode is confusion about where something went, which is worse than a feature
that simply does not work.

Every one of them must be reversible by a single switch, and switching it off must leave things
exactly as visible as they were before it went on.

## Bookmarks that follow the container

The bar shows only the bookmarks of the container currently in view. Everything else parks in
`Other bookmarks / WebSpaces / <container>`. Chrome cannot filter what the bar displays, so the
entries are physically moved.

### The invariant

**Every top level entry on the bar belongs to exactly one container**, or to the pinned set that
survives every switch. Without that, an unowned entry would stay on the bar in every container,
which defeats the point: in Company X you want Company X and nothing else.

That is why switching the feature on adopts the whole existing bar into the **default**
container. Those bookmarks have to belong to somebody, and the default container is the drawer
for everything not claimed by a specific one. It is also where a deleted container sends its
bookmarks, so the two rules agree.

Folders move as units. A folder of twenty links is one move and arrives intact.

### Ownership

- Adopted on first enable: everything on the bar becomes the default container, because nothing
  is mounted yet.
- Created later: whatever container is showing when the bookmark lands on the bar owns it.
- Restored from a parking folder: assigned to that container, including anything the user
  dropped into the folder by hand.
- Found unowned on the bar: claimed by the container currently showing. `claimBar` runs on every
  start, after every sync pull and before every listing in settings, so nothing stays stranded.

That last one is not belt and braces. `pullFromSync` writes settings straight to storage, so the
feature can arrive from another profile already switched on, with no checkbox ever ticked on this
machine and therefore no adoption. The bar then belongs to nobody: it never parks, never comes
back, and shows nowhere in settings. The panel looked empty over a full bar, which is the least
explainable state this feature can be in. Claiming on every entry point is what closes it, and the
panel states how many entries the extension can see on the bar so the next such gap is visible
rather than puzzling.

### Choosing the container

Chrome keeps every native bookmark surface closed to extensions. There is **no `bookmark` context**
in `chrome.contextMenus` (Firefox has one, Chrome does not), and neither the star button bubble nor
the edit dialog can be extended. So the container cannot be picked where it would be most natural:
right-clicking an entry on the bar, saving with the star, or editing an entry afterwards.

Two surfaces stand in for those:

| Want | Where |
|---|---|
| save this page into a container | right-click the page or the extension icon, **Bookmark page in container** |
| hand an existing entry to another container | **Settings > Experimental > Who owns what** |

The menu appears only while the feature is on, because with one shared bar it would mean nothing.
When the target container is not the one showing, the entry goes straight to its parking folder and
nothing appears on screen, so the toolbar badge flashes a plus in that container colour. A menu
entry that looks like it did nothing is worse than no menu entry.

The list in settings moves the entry as well as the ownership. Ownership alone would leave it on
the wrong bar, since the owner is precisely what decides where it physically sits.

### Deleting a container

`orphanBookmarks` decides:

- `default` - the bookmarks move to the default container, so they reappear there. This is the
  setting that answers "do not lose them".
- `everywhere` - ownership is dropped and they stay on the bar in every container.

The parking folder is removed afterwards, never before, so a failure mid-move leaves the
bookmarks somewhere findable.

### Ways out

- Switching the feature off restores everything to the bar and forgets all ownership.
- The button in settings does the same without changing the setting.
- If the extension disappears entirely, the parked bookmarks are still sitting in
  `Other bookmarks / WebSpaces`, in folders named after their containers.

### Known costs

- **Chrome syncs the bookmark tree.** Moving entries produces sync traffic, and a second machine
  also running WebSpaces would be rearranging the same tree from the other side. This is the main
  reason the feature is experimental rather than default.
- **Order within the bar drifts.** `chrome.bookmarks.move` appends, so a container bookmarks come
  back in the order they were parked rather than where they used to sit.
- Switching is debounced by 700 ms, so flicking through tabs costs nothing and only settling on a
  container triggers a move.
