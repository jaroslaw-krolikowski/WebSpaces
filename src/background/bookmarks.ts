import { loadState } from "../shared/storage";
import { ALWAYS_VISIBLE, DEFAULT_CONTAINER_ID } from "../shared/types";
import type { BookmarkEntry, Container, OrphanBookmarks } from "../shared/types";

/**
 * Per-container bookmarks.
 *
 * The same idea as the cookie vault, applied to the bookmarks bar: the bar shows
 * exactly the bookmarks of the container you are in, and everybody else parks in
 * a folder under Other bookmarks. Chrome cannot filter what the bar displays, so
 * the entries are physically moved.
 *
 * The invariant that makes this predictable: **every top level entry on the bar
 * belongs to exactly one container**, or to the pinned set that survives every
 * switch. Whatever is on the bar when the feature is switched on becomes the
 * property of the default container, so turning it on hides nothing and losing
 * the extension leaves everything recoverable in one folder.
 *
 * Folders move as units, so a folder of twenty links costs one move, not twenty.
 */

const VAULT_FOLDER = "WebSpaces";
const OWNERS_KEY = "bookmarkOwners";
const FOLDERS_KEY = "bookmarkFolders";
const MOUNTED_KEY = "bookmarksMounted";

type Owners = Record<string, string>;

async function readOwners(): Promise<Owners> {
  const raw = await chrome.storage.local.get(OWNERS_KEY);
  return (raw[OWNERS_KEY] as Owners | undefined) ?? {};
}

async function writeOwners(owners: Owners): Promise<void> {
  await chrome.storage.local.set({ [OWNERS_KEY]: owners });
}

async function readMounted(): Promise<string | null> {
  const raw = await chrome.storage.local.get(MOUNTED_KEY);
  return (raw[MOUNTED_KEY] as string | undefined) ?? null;
}

/** The bookmarks bar, found by its declared type rather than a hardcoded id. */
async function barId(): Promise<string> {
  const tree = await chrome.bookmarks.getTree();
  const found = find(tree, (node) => node.folderType === "bookmarks-bar");
  if (found) return found.id;
  // Older Chrome builds do not report folderType; the bar is the first root child.
  return tree[0]?.children?.[0]?.id ?? "1";
}

async function otherId(): Promise<string> {
  const tree = await chrome.bookmarks.getTree();
  const found = find(tree, (node) => node.folderType === "other");
  return found?.id ?? tree[0]?.children?.[1]?.id ?? "2";
}

function find(
  nodes: chrome.bookmarks.BookmarkTreeNode[],
  match: (node: chrome.bookmarks.BookmarkTreeNode) => boolean,
): chrome.bookmarks.BookmarkTreeNode | null {
  for (const node of nodes) {
    if (match(node)) return node;
    const inner = node.children ? find(node.children, match) : null;
    if (inner) return inner;
  }
  return null;
}

function walk(
  nodes: chrome.bookmarks.BookmarkTreeNode[],
  visit: (node: chrome.bookmarks.BookmarkTreeNode) => void,
): void {
  for (const node of nodes) {
    visit(node);
    if (node.children) walk(node.children, visit);
  }
}

async function ensureVaultFolder(): Promise<string> {
  const other = await otherId();
  const children = await chrome.bookmarks.getChildren(other);
  const existing = children.find((node) => !node.url && node.title === VAULT_FOLDER);
  if (existing) return existing.id;

  const created = await chrome.bookmarks.create({ parentId: other, title: VAULT_FOLDER });
  return created.id;
}

/** The parking folder for one container, created on first use. */
async function folderFor(containerId: string, containers: Container[]): Promise<string> {
  const raw = await chrome.storage.local.get(FOLDERS_KEY);
  const folders = (raw[FOLDERS_KEY] as Record<string, string> | undefined) ?? {};

  const known = folders[containerId];
  if (known) {
    // The user can delete the folder by hand, so a stored id is a hint, not a fact.
    const alive = await chrome.bookmarks.get(known).catch(() => null);
    if (alive?.length) return known;
  }

  const name = containers.find((c) => c.id === containerId)?.name ?? containerId;
  const parent = await ensureVaultFolder();
  const created = await chrome.bookmarks.create({ parentId: parent, title: name });
  folders[containerId] = created.id;
  await chrome.storage.local.set({ [FOLDERS_KEY]: folders });
  return created.id;
}

/**
 * First run: everything already on the bar becomes the property of the default
 * container. Switching on the feature must not make anything disappear, and the
 * bookmarks someone has collected over years are the default set by any sane
 * reading.
 */
export async function adoptExistingBar(): Promise<number> {
  const owners = await readOwners();
  const bar = await barId();
  let adopted = 0;

  for (const child of await chrome.bookmarks.getChildren(bar)) {
    if (owners[child.id]) continue;
    owners[child.id] = DEFAULT_CONTAINER_ID;
    adopted += 1;
  }

  await writeOwners(owners);
  await chrome.storage.local.set({ [MOUNTED_KEY]: DEFAULT_CONTAINER_ID });
  return adopted;
}

/**
 * Brings one container bookmarks onto the bar and parks whoever was there.
 * Entries owned by ALWAYS_VISIBLE are left alone, which is what pins them everywhere.
 */
export async function mountBookmarks(containerId: string, containers: Container[]): Promise<void> {
  const state = await loadState();
  if (!state.settings.bookmarksPerContainer) return;

  const current = (await readMounted()) ?? DEFAULT_CONTAINER_ID;
  if (current === containerId) return;

  const bar = await barId();
  const owners = await readOwners();

  // Anything that appeared on the bar unowned belongs to whoever was mounted,
  // otherwise it would be stranded and never park with anything.
  const onBar = await chrome.bookmarks.getChildren(bar);
  for (const child of onBar) {
    if (!owners[child.id]) owners[child.id] = current;
  }

  const parking = await folderFor(current, containers);
  for (const child of onBar) {
    if (owners[child.id] !== current) continue;
    await chrome.bookmarks.move(child.id, { parentId: parking }).catch(() => undefined);
  }

  const folder = await folderFor(containerId, containers);
  for (const child of await chrome.bookmarks.getChildren(folder)) {
    await chrome.bookmarks.move(child.id, { parentId: bar }).catch(() => undefined);
    // Anything restored from the folder belongs to this container, including
    // whatever the user dropped in there by hand.
    owners[child.id] = containerId;
  }

  await writeOwners(owners);
  await chrome.storage.local.set({ [MOUNTED_KEY]: containerId });
}

/** A bookmark added to the bar belongs to the container that is showing. */
export async function noteCreated(
  id: string,
  node: chrome.bookmarks.BookmarkTreeNode,
): Promise<void> {
  const state = await loadState();
  if (!state.settings.bookmarksPerContainer) return;
  if (node.parentId !== (await barId())) return;

  const owners = await readOwners();
  // "Bookmark page in container X" writes the owner itself, and this event
  // fires for that creation too. The explicit choice must win over the bar.
  if (owners[id]) return;
  owners[id] = (await readMounted()) ?? DEFAULT_CONTAINER_ID;
  await writeOwners(owners);
}

export async function noteRemoved(id: string): Promise<void> {
  const owners = await readOwners();
  if (!(id in owners)) return;
  delete owners[id];
  await writeOwners(owners);
}

/**
 * Everything the extension owns, with dead ids swept on the way out. Chrome can
 * remove a bookmark while the service worker sleeps, and a stale id would appear
 * in settings as a row that moves nowhere.
 */
export async function listOwned(): Promise<BookmarkEntry[]> {
  const owners = await readOwners();
  const alive = new Map<string, chrome.bookmarks.BookmarkTreeNode>();
  walk(await chrome.bookmarks.getTree(), (node) => alive.set(node.id, node));

  const entries: BookmarkEntry[] = [];
  let pruned = false;

  for (const [id, owner] of Object.entries(owners)) {
    const node = alive.get(id);
    if (!node) {
      delete owners[id];
      pruned = true;
      continue;
    }
    entries.push({ id, title: node.title || (node.url ?? ""), url: node.url ?? null, owner });
  }

  if (pruned) await writeOwners(owners);
  return entries.sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Hands one entry to another container. Ownership alone would not be enough:
 * the owner decides where the entry physically lives, so it moves to the bar
 * when that container is the one on screen and to its parking folder otherwise.
 *
 * This is the only way to reassign a bookmark, because Chrome exposes no
 * "bookmark" context for extension menus - see docs/07-experimental.md.
 */
export async function assignBookmark(
  bookmarkId: string,
  owner: string,
  containers: Container[],
): Promise<void> {
  const owners = await readOwners();
  const mounted = (await readMounted()) ?? DEFAULT_CONTAINER_ID;
  const parent =
    owner === ALWAYS_VISIBLE || owner === mounted
      ? await barId()
      : await folderFor(owner, containers);

  await chrome.bookmarks.move(bookmarkId, { parentId: parent });
  owners[bookmarkId] = owner;
  await writeOwners(owners);
}

/**
 * Saves a page straight into a container, whether or not that container is the
 * one showing. Chrome does not let an extension into the star button bubble, so
 * choosing the container while saving has to happen somewhere else entirely.
 */
export async function bookmarkPage(
  url: string,
  title: string,
  containerId: string,
  containers: Container[],
): Promise<boolean> {
  const mounted = (await readMounted()) ?? DEFAULT_CONTAINER_ID;
  const onBar = containerId === mounted;
  const parent = onBar ? await barId() : await folderFor(containerId, containers);

  const created = await chrome.bookmarks.create({ parentId: parent, title, url });
  const owners = await readOwners();
  owners[created.id] = containerId;
  await writeOwners(owners);
  // The caller says where it went, because a bookmark parked in a folder for
  // another container leaves nothing at all to see.
  return onBar;
}

/**
 * Where the bookmarks of a deleted container go: to the default container, so
 * they come back when nothing else is mounted, or pinned to the bar for good.
 */
export async function releaseContainer(
  containerId: string,
  mode: OrphanBookmarks,
  containers: Container[],
): Promise<void> {
  const owners = await readOwners();
  const mounted = (await readMounted()) ?? DEFAULT_CONTAINER_ID;
  const bar = await barId();
  const folder = await folderFor(containerId, containers);

  // The entries are parked in the folder, unless this container is the one on
  // screen, in which case they are on the bar. Both places are collected.
  const parked = await chrome.bookmarks.getChildren(folder);
  const showing =
    mounted === containerId
      ? (await chrome.bookmarks.getChildren(bar)).filter((n) => owners[n.id] === containerId)
      : [];

  for (const node of [...parked, ...showing]) {
    if (mode === "everywhere") {
      await chrome.bookmarks.move(node.id, { parentId: bar }).catch(() => undefined);
      owners[node.id] = ALWAYS_VISIBLE;
      continue;
    }

    const destination =
      mounted === DEFAULT_CONTAINER_ID ? bar : await folderFor(DEFAULT_CONTAINER_ID, containers);
    await chrome.bookmarks.move(node.id, { parentId: destination }).catch(() => undefined);
    owners[node.id] = DEFAULT_CONTAINER_ID;
  }

  await writeOwners(owners);
  await chrome.bookmarks.removeTree(folder).catch(() => undefined);

  const raw = await chrome.storage.local.get(FOLDERS_KEY);
  const folders = (raw[FOLDERS_KEY] as Record<string, string> | undefined) ?? {};
  delete folders[containerId];
  await chrome.storage.local.set({ [FOLDERS_KEY]: folders });
  if (mounted === containerId) {
    await chrome.storage.local.set({ [MOUNTED_KEY]: DEFAULT_CONTAINER_ID });
  }
}

/**
 * Puts every parked entry back on the bar and forgets all ownership. This is the
 * way out: switching the feature off, or pressing the button in settings, leaves
 * the bar holding everything again, exactly as it was before it went on.
 */
export async function restoreAll(): Promise<number> {
  const bar = await barId();
  const raw = await chrome.storage.local.get(FOLDERS_KEY);
  const folders = (raw[FOLDERS_KEY] as Record<string, string> | undefined) ?? {};
  let moved = 0;

  for (const folderId of Object.values(folders)) {
    for (const child of await chrome.bookmarks.getChildren(folderId).catch(() => [])) {
      await chrome.bookmarks.move(child.id, { parentId: bar }).catch(() => undefined);
      moved += 1;
    }
  }

  // The vault may hold folders created before a container was renamed, so it is
  // swept rather than only the folders currently tracked.
  const vault = await ensureVaultFolder();
  for (const folder of await chrome.bookmarks.getChildren(vault).catch(() => [])) {
    for (const child of await chrome.bookmarks.getChildren(folder.id).catch(() => [])) {
      await chrome.bookmarks.move(child.id, { parentId: bar }).catch(() => undefined);
      moved += 1;
    }
  }
  await chrome.bookmarks.removeTree(vault).catch(() => undefined);

  await chrome.storage.local.remove([OWNERS_KEY, FOLDERS_KEY, MOUNTED_KEY]);
  return moved;
}
