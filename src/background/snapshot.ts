import { loadState, loadVault, saveState } from "../shared/storage";
import type { Snapshot, SnapshotGroup, SnapshotWindow } from "../shared/messages";
import type { GroupColor } from "../shared/types";
import { buildGroupMap } from "./tabs";

const NO_GROUP = -1;
const RESTORABLE = /^(https?|file):/i;
const ACCEPTED_FORMATS = ["webspaces-snapshot", "tenantlock-snapshot", "omnitab-snapshot"];

/** Builds a snapshot: containers, realms, rules, and the window/tab tree. */
export async function buildSnapshot(includeCookies: boolean): Promise<Snapshot> {
  const state = await loadState();
  const groupMap = await buildGroupMap(state.containers);
  const byId = new Map(state.containers.map((c) => [c.id, c]));
  const browserWindows = await chrome.windows.getAll({ populate: true });

  const windows: SnapshotWindow[] = [];
  for (const win of browserWindows) {
    if (win.id === undefined) continue;
    const groupMeta = await chrome.tabGroups.query({ windowId: win.id });
    const metaById = new Map(groupMeta.map((g) => [g.id, g]));
    const buckets = new Map<number, SnapshotGroup>();

    for (const tab of win.tabs ?? []) {
      if (!tab.url || !RESTORABLE.test(tab.url)) continue;
      const groupId = tab.groupId ?? NO_GROUP;
      let bucket = buckets.get(groupId);
      if (!bucket) {
        const meta = metaById.get(groupId);
        const containerId = groupMap[groupId];
        bucket = {
          containerName: containerId ? (byId.get(containerId)?.name ?? null) : (meta?.title ?? null),
          color: meta?.color ?? null,
          collapsed: meta?.collapsed ?? false,
          tabs: [],
        };
        buckets.set(groupId, bucket);
      }
      bucket.tabs.push({ url: tab.url, title: tab.title ?? "", pinned: tab.pinned });
    }

    if (buckets.size > 0) {
      windows.push({ incognito: win.incognito, groups: [...buckets.values()] });
    }
  }

  const snapshot: Snapshot = {
    format: "webspaces-snapshot",
    version: 1,
    savedAt: new Date().toISOString(),
    containers: state.containers,
    realms: state.realms,
    rules: state.rules,
    windows,
  };

  // Cookies are live sign-in sessions in plain text, so only on explicit request.
  if (includeCookies) snapshot.vault = (await loadVault()) as Snapshot["vault"];

  return snapshot;
}

/** Loads a snapshot: merges the configuration, optionally restores windows. */
export async function applySnapshot(snapshot: Snapshot, restoreWindows: boolean): Promise<void> {
  // The older format names come from before the renames — files exported back
  // then still have to load.
  if (!ACCEPTED_FORMATS.includes(snapshot.format)) {
    throw new Error("This is not a WebSpaces snapshot file.");
  }

  const state = await loadState();
  const containers = mergeById(state.containers, snapshot.containers ?? []);
  const realms = mergeById(state.realms, snapshot.realms ?? []);
  const rules = mergeById(state.rules, snapshot.rules ?? []);
  await saveState({ containers, realms, rules });

  if (!restoreWindows) return;

  const byName = new Map(containers.map((c) => [c.name.toLowerCase(), c]));
  for (const win of snapshot.windows ?? []) {
    for (const group of win.groups) {
      const urls = group.tabs.map((t) => t.url).filter((u) => RESTORABLE.test(u));
      if (urls.length === 0) continue;

      const created = await chrome.windows.create({ url: urls, focused: false });
      const [firstTab, ...restTabs] = (created?.tabs ?? [])
        .map((t) => t.id)
        .filter((id): id is number => id !== undefined);
      // The grouping API needs a non-empty list, hence the head/tail split.
      if (firstTab === undefined || !group.containerName) continue;

      const groupId = await chrome.tabs.group({ tabIds: [firstTab, ...restTabs] });
      const container = byName.get(group.containerName.toLowerCase());
      await chrome.tabGroups.update(groupId, {
        title: group.containerName,
        color: (container?.color ?? group.color ?? "grey") as GroupColor,
        collapsed: group.collapsed,
      });
    }
  }
}

/** Entries from the snapshot overwrite existing ones with the same id. */
function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return [...merged.values()];
}
