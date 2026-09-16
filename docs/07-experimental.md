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

- Adopted on first enable: everything on the bar becomes the default container.
- Created later: whatever container is showing when the bookmark lands on the bar owns it.
- Restored from a parking folder: assigned to that container, including anything the user
  dropped into the folder by hand.
- Found unowned on the bar during a switch: assigned to the container being parked, so nothing
  is ever stranded.

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
