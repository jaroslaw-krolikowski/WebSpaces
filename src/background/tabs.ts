import {
  clearTabContainer,
  getGroupBindings,
  getTabMap,
  setGroupBinding,
  setTabContainer,
  uid,
} from "../shared/storage";
import { DEFAULT_CONTAINER_ID } from "../shared/types";
import type { Container, GroupColor } from "../shared/types";

const NO_GROUP = -1;

/**
 * Maps tab group to container. The explicit binding comes first because it
 * survives a group rename; the title match is the fallback that rebuilds
 * everything after a browser restart, when group ids are different.
 */
export async function buildGroupMap(containers: Container[]): Promise<Record<number, string>> {
  const [groups, bindings] = await Promise.all([chrome.tabGroups.query({}), getGroupBindings()]);
  const byName = new Map(containers.map((c) => [c.name.toLowerCase(), c.id]));
  const known = new Set(containers.map((c) => c.id));
  const map: Record<number, string> = {};

  for (const group of groups) {
    const bound = bindings[group.id];
    if (bound !== undefined && known.has(bound)) {
      map[group.id] = bound;
      continue;
    }
    const title = (group.title ?? "").trim();
    const byTitle = title ? byName.get(title.toLowerCase()) : undefined;
    if (byTitle) map[group.id] = byTitle;
  }
  return map;
}

/**
 * Adopts named tab groups created by hand in Chrome into the container list.
 * This is the core premise of the extension: a container and a tab group are
 * one thing, not two parallel lists to reconcile by hand.
 *
 * Unnamed groups are skipped — there is nothing to identify them by after a
 * restart. Returns the containers to append; an empty array when nothing is new.
 */
export async function adoptGroups(containers: Container[]): Promise<Container[]> {
  const [groups, bindings] = await Promise.all([chrome.tabGroups.query({}), getGroupBindings()]);
  const known = new Set(containers.map((c) => c.id));
  const byName = new Map(containers.map((c) => [c.name.toLowerCase(), c]));
  const added: Container[] = [];

  for (const group of groups) {
    const bound = bindings[group.id];
    if (bound !== undefined && known.has(bound)) continue;

    const title = (group.title ?? "").trim();
    if (!title) continue;

    const existing = byName.get(title.toLowerCase());
    if (existing) {
      await setGroupBinding(group.id, existing.id);
      continue;
    }

    const container: Container = {
      id: uid(),
      name: title,
      color: group.color as GroupColor,
      isolate: true,
      createdAt: Date.now(),
    };
    added.push(container);
    byName.set(title.toLowerCase(), container);
    await setGroupBinding(group.id, container.id);
  }
  return added;
}

/** The container assignment for every open tab. */
export async function resolveAllTabs(containers: Container[]): Promise<Record<number, string>> {
  const [groupMap, tabMap, tabs] = await Promise.all([
    buildGroupMap(containers),
    getTabMap(),
    chrome.tabs.query({}),
  ]);
  const result: Record<number, string> = {};
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    const viaGroup = tab.groupId !== NO_GROUP ? groupMap[tab.groupId] : undefined;
    result[tab.id] = viaGroup ?? tabMap[tab.id] ?? DEFAULT_CONTAINER_ID;
  }
  return result;
}

export async function resolveTab(tabId: number, containers: Container[]): Promise<string> {
  const all = await resolveAllTabs(containers);
  return all[tabId] ?? DEFAULT_CONTAINER_ID;
}

/**
 * Moves a tab into a container: stores the assignment and puts the tab into the
 * right tab group, creating that group in the window when it does not exist yet.
 */
export async function assignTabToContainer(tabId: number, container: Container): Promise<void> {
  await setTabContainer(tabId, container.id);
  const tab = await chrome.tabs.get(tabId);

  if (container.id === DEFAULT_CONTAINER_ID) {
    // The default container owns no group, so the tab simply leaves its group.
    if (tab.groupId !== NO_GROUP) await chrome.tabs.ungroup(tabId);
    return;
  }

  const [groups, bindings] = await Promise.all([
    chrome.tabGroups.query({ windowId: tab.windowId }),
    getGroupBindings(),
  ]);
  const existing =
    groups.find((g) => bindings[g.id] === container.id) ??
    groups.find((g) => (g.title ?? "").toLowerCase() === container.name.toLowerCase());

  if (existing) {
    await chrome.tabs.group({ tabIds: tabId, groupId: existing.id });
    await setGroupBinding(existing.id, container.id);
    return;
  }

  const groupId = await chrome.tabs.group({
    tabIds: tabId,
    createProperties: { windowId: tab.windowId },
  });
  await chrome.tabGroups.update(groupId, { title: container.name, color: container.color });
  await setGroupBinding(groupId, container.id);
}

export async function forgetTab(tabId: number): Promise<void> {
  await clearTabContainer(tabId);
}
