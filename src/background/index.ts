import type { Overview, PendingInfo, Request, Snapshot, TabStatus } from "../shared/messages";
import { realmForUrl, ruleMatches } from "../shared/realms";
import {
  clearGroupBinding,
  clearTabContainer,
  dropVaultContainer,
  dropVaultRealm,
  getGroupBindings,
  loadState,
  saveState,
  setPendingUrl,
  takePendingUrl,
  uid,
} from "../shared/storage";
import { COLOR_HEX, DEFAULT_CONTAINER_ID, GROUP_COLORS } from "../shared/types";
import type { Container, GroupColor, Realm } from "../shared/types";
import { BACKUP_ALARM, rescheduleBackup, runBackup, runScheduledBackup } from "./backup";
import { disconnect as driveDisconnect, isConfigured as driveConfigured } from "./drive";
import { frozenCounts, refreshGate, scheduleGateRefresh } from "./gate";
import { mountContainer, mountedContainer, noteCookieChange } from "./mount";
import { applySnapshot, buildSnapshot } from "./snapshot";
import { adoptGroups, assignTabToContainer, resolveAllTabs, resolveTab } from "./tabs";

/* --- Lifecycle --- */

chrome.runtime.onInstalled.addListener(() => {
  void bootstrap();
});

chrome.runtime.onStartup.addListener(() => {
  void bootstrap();
});

async function bootstrap(): Promise<void> {
  await loadState();
  await syncContainersWithGroups();
  await rebuildContextMenus();
  await applyRulesToOpenTabs();
  await refreshGate();
  await rescheduleBackup();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BACKUP_ALARM) void runScheduledBackup();
});

/* --- Tab and group events --- */

chrome.tabs.onCreated.addListener((tab) => {
  void inheritContainer(tab);
});

/**
 * A tab opened from a container tab stays in that same container.
 *
 * Without this, a target="_blank" link, a download window, and every popup
 * landed in the default container. With a different container mounted, such a
 * tab was frozen from the start and the gate cut off its requests - downloads
 * died with no message at all. Firefox containers behave the same way.
 */
async function inheritContainer(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined || tab.openerTabId === undefined) {
    scheduleGateRefresh();
    return;
  }

  const state = await loadState();
  const inherited = await resolveTab(tab.openerTabId, state.containers);
  const container = state.containers.find((c) => c.id === inherited);

  if (container && container.id !== DEFAULT_CONTAINER_ID) {
    // Grouping fails for popup windows, but the assignment alone is what the
    // gate needs, so a failed grouping breaks nothing.
    await assignTabToContainer(tab.id, container).catch(() => undefined);
  }

  // No delay here: the first request of a new tab can outrun the debounce.
  await refreshGate();
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearTabContainer(tabId);
  scheduleGateRefresh();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.groupId !== undefined || changeInfo.url) scheduleGateRefresh();
  if (changeInfo.status === "complete") void updateBadge(tabId);
});

chrome.tabGroups.onCreated.addListener((group) => {
  void onGroupChanged(group);
});

chrome.tabGroups.onUpdated.addListener((group) => {
  void onGroupChanged(group);
});

chrome.tabGroups.onRemoved.addListener((group) => {
  // The container stays: it holds a cookie vault that must survive closing the
  // last tab. Only the binding to a group that no longer exists goes away.
  void clearGroupBinding(group.id);
  scheduleGateRefresh();
});

/**
 * A tab group was created or changed in Chrome. A named group with no
 * counterpart becomes a container, and renaming or recolouring a bound group
 * carries over to its container. That is what makes a group and a container one
 * thing, no matter which side you start from.
 */
async function onGroupChanged(group: chrome.tabGroups.TabGroup): Promise<void> {
  const title = (group.title ?? "").trim();
  const bindings = await getGroupBindings();
  const boundId = bindings[group.id];
  const state = await loadState();
  const bound = boundId ? state.containers.find((c) => c.id === boundId) : undefined;

  if (bound && title) {
    // Names have to stay unique, so on a clash the container keeps its own.
    const clash = state.containers.some(
      (c) => c.id !== bound.id && c.name.toLowerCase() === title.toLowerCase(),
    );
    const nextName = clash ? bound.name : title;
    const nextColor = group.color as GroupColor;

    if (nextName !== bound.name || nextColor !== bound.color) {
      await saveState({
        containers: state.containers.map((c) =>
          c.id === bound.id ? { ...c, name: nextName, color: nextColor } : c,
        ),
      });
      await rebuildContextMenus();
    }
  } else {
    await syncContainersWithGroups();
  }

  scheduleGateRefresh();
}

/** Pulls every named group that has no container yet into the container list. */
async function syncContainersWithGroups(): Promise<void> {
  const state = await loadState();
  const added = await adoptGroups(state.containers);
  if (added.length === 0) return;
  await saveState({ containers: [...state.containers, ...added] });
  await rebuildContextMenus();
}

chrome.tabs.onActivated.addListener((info) => {
  void onTabActivated(info.tabId);
});

async function onTabActivated(tabId: number): Promise<void> {
  const state = await loadState();
  await updateBadge(tabId);

  if (!state.settings.autoMountOnFocus) {
    scheduleGateRefresh();
    return;
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const realm = tab?.url ? realmForUrl(state.realms, tab.url) : null;
  if (!realm) {
    scheduleGateRefresh();
    return;
  }

  const containerId = await resolveTab(tabId, state.containers);
  const container = state.containers.find((c) => c.id === containerId);
  if (container?.isolate) await mountContainer(realm, containerId);
  await refreshGate();
}

/**
 * Remembers where a tab was heading before the gate redirected it.
 *
 * EVERY top-level navigation is stored, with no realm check. There used to be a
 * realm condition here and it lost the most common case: opening an address
 * outside any realm that only redirects to the sign-in screen server-side. The
 * original address is also a better return target than the end of a redirect chain.
 */
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0 || !details.url.startsWith("http")) return;
  void setPendingUrl(details.tabId, details.url);
});

/**
 * Rules have to work for EVERY address, not just realm hosts. Realm hosts go
 * through the gate and the picker, where the rule is settled before any request
 * is sent. Everything else - ordinary pages with no isolation - arrives here,
 * once the navigation has committed.
 */
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  void applyRuleToTab(details.tabId, details.url);
});

async function applyRuleToTab(tabId: number, url: string): Promise<void> {
  const state = await loadState();
  const rule = state.rules.find((r) => r.enabled && ruleMatches(r.pattern, url));
  if (!rule) return;

  const container = state.containers.find((c) => c.id === rule.containerId);
  if (!container) return;
  if ((await resolveTab(tabId, state.containers)) === container.id) return;

  await assignTabToContainer(tabId, container);
  const realm = realmForUrl(state.realms, url);
  if (realm && container.isolate) await mountContainer(realm, container.id);
  await refreshGate();
  await updateBadge(tabId);
}

/**
 * Applies rules to tabs that are already open. Without this, adding a rule
 * would do nothing visible until the next navigation, which looks like a
 * broken feature.
 */
async function applyRulesToOpenTabs(): Promise<number> {
  const state = await loadState();
  if (state.rules.length === 0) return 0;

  const byTab = await resolveAllTabs(state.containers);
  const byId = new Map(state.containers.map((c) => [c.id, c]));
  const tabs = await chrome.tabs.query({});
  let moved = 0;

  for (const tab of tabs) {
    const url = tab.url;
    if (tab.id === undefined || !url) continue;

    const rule = state.rules.find((r) => r.enabled && ruleMatches(r.pattern, url));
    if (!rule) continue;
    const container = byId.get(rule.containerId);
    if (!container) continue;
    if ((byTab[tab.id] ?? DEFAULT_CONTAINER_ID) === container.id) continue;

    await assignTabToContainer(tab.id, container);
    await updateBadge(tab.id);
    moved += 1;
  }

  if (moved > 0) await refreshGate();
  return moved;
}

chrome.cookies.onChanged.addListener((info) => {
  void (async () => {
    const state = await loadState();
    await noteCookieChange(info.cookie, state.realms);
  })();
});

/* --- Context menus --- */

type MenuContext = `${chrome.contextMenus.ContextType}`;

/**
 * Chrome exposes the tab strip menu (the "tab" context) to extensions only from
 * version 149. On older releases we fall back to the page and action menus,
 * which work everywhere - the feature stays, only the place you click changes.
 */
function supportsTabContext(): boolean {
  const match = /Chrome\/(\d+)/.exec(navigator.userAgent);
  return match?.[1] !== undefined && Number(match[1]) >= 149;
}

async function rebuildContextMenus(): Promise<void> {
  // Menus are a convenience, not a critical feature. Their failure must not
  // topple an operation that already saved state, such as adding a container.
  try {
    await chrome.contextMenus.removeAll();
    const state = await loadState();

    chrome.contextMenus.create({
      id: "webspaces-open",
      title: "Open link in container",
      contexts: ["link"],
    });

    const moveContexts: [MenuContext, ...MenuContext[]] = supportsTabContext()
      ? ["tab", "page", "action"]
      : ["page", "action"];
    chrome.contextMenus.create({
      id: "webspaces-move",
      title: "Move tab to container",
      contexts: moveContexts,
    });

    for (const container of state.containers) {
      chrome.contextMenus.create({
        id: `webspaces-open:${container.id}`,
        parentId: "webspaces-open",
        title: container.name,
        contexts: ["link"],
      });
      chrome.contextMenus.create({
        id: `webspaces-move:${container.id}`,
        parentId: "webspaces-move",
        title: container.name,
        contexts: moveContexts,
      });
    }
  } catch (error) {
    console.error("WebSpaces: could not rebuild the context menus", error);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId);

  if (id.startsWith("webspaces-open:") && info.linkUrl) {
    void openInContainer(info.linkUrl, id.slice("webspaces-open:".length), tab?.windowId);
    return;
  }
  // In the "tab" context Chrome passes the clicked tab rather than the active
  // one, which is exactly the tab the user meant.
  if (id.startsWith("webspaces-move:") && tab?.id !== undefined) {
    void moveTabToContainer(tab.id, id.slice("webspaces-move:".length));
  }
});

/**
 * Moves a tab into a container. When the tab sits on a realm host it also
 * mounts that container session and reloads the tab - without that the page
 * would keep showing the previous account and would shortly hit the gate as frozen.
 */
async function moveTabToContainer(tabId: number, containerId: string): Promise<void> {
  const state = await loadState();
  const container = state.containers.find((c) => c.id === containerId);
  if (!container) return;

  await assignTabToContainer(tabId, container);

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const realm = tab?.url ? realmForUrl(state.realms, tab.url) : null;
  if (realm && container.isolate) await mountContainer(realm, container.id);

  await refreshGate();
  await updateBadge(tabId);
  // Reload only when changing the container actually changes anything for this
  // page, which means when its host belongs to a realm.
  if (realm) await chrome.tabs.reload(tabId);
}

/**
 * Opens an address in a container. The tab starts on about:blank so there is
 * time to set the gate and swap cookies before the first request goes out.
 */
async function openInContainer(
  url: string,
  containerId: string,
  windowId?: number,
): Promise<void> {
  const state = await loadState();
  const container = state.containers.find((c) => c.id === containerId);
  if (!container) return;

  const tab = await chrome.tabs.create({
    url: "about:blank",
    active: true,
    ...(windowId === undefined ? {} : { windowId }),
  });
  if (tab.id === undefined) return;

  await assignTabToContainer(tab.id, container);
  const realm = realmForUrl(state.realms, url);
  if (realm && container.isolate) await mountContainer(realm, container.id);
  await refreshGate();
  await chrome.tabs.update(tab.id, { url });
}

/* --- Toolbar badge --- */

async function updateBadge(tabId: number): Promise<void> {
  const state = await loadState();
  const containerId = await resolveTab(tabId, state.containers);
  const container = state.containers.find((c) => c.id === containerId);
  const text =
    !container || container.id === DEFAULT_CONTAINER_ID
      ? ""
      : container.name.slice(0, 2).toUpperCase();

  await chrome.action.setBadgeText({ tabId, text }).catch(() => undefined);
  if (container) {
    await chrome.action
      .setBadgeBackgroundColor({ tabId, color: COLOR_HEX[container.color] })
      .catch(() => undefined);
  }
}

/* --- Message protocol --- */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handle(message as Request)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({ error: error instanceof Error ? error.message : String(error) });
    });
  return true;
});

async function handle(request: Request): Promise<unknown> {
  switch (request.type) {
    case "getOverview":
      return buildOverview();

    case "mount": {
      const state = await loadState();
      const realm = state.realms.find((r) => r.id === request.realmId);
      if (!realm) throw new Error("No such realm.");
      await mountContainer(realm, request.containerId);
      await refreshGate();
      return { ok: true };
    }

    case "assignTab": {
      const state = await loadState();
      const container = state.containers.find((c) => c.id === request.containerId);
      if (!container) throw new Error("No such container.");
      await assignTabToContainer(request.tabId, container);
      await refreshGate();
      await updateBadge(request.tabId);
      return { ok: true };
    }

    case "createContainer": {
      const state = await loadState();
      const name = request.name.trim();
      if (!name) throw new Error("The name cannot be empty.");
      if (state.containers.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
        throw new Error("A container with that name already exists - names must be unique.");
      }
      const container: Container = {
        id: uid(),
        name,
        color: (request.color as GroupColor) || pickColor(state.containers),
        isolate: true,
        createdAt: Date.now(),
      };
      await saveState({ containers: [...state.containers, container] });
      await rebuildContextMenus();
      await refreshGate();
      return container;
    }

    case "updateContainer": {
      const state = await loadState();
      const previous = state.containers.find((c) => c.id === request.container.id);
      const containers = state.containers.map((c) =>
        c.id === request.container.id ? request.container : c,
      );
      await saveState({ containers });

      // The name and colour of a container are the name and colour of its
      // group, so the change has to reach every window. We look the group up by
      // binding, with the title as a fallback.
      if (
        previous &&
        (previous.name !== request.container.name || previous.color !== request.container.color)
      ) {
        const bindings = await getGroupBindings();
        const groups = await chrome.tabGroups.query({});
        for (const group of groups) {
          const matches =
            bindings[group.id] === request.container.id ||
            (group.title ?? "").toLowerCase() === previous.name.toLowerCase();
          if (!matches) continue;
          await chrome.tabGroups.update(group.id, {
            title: request.container.name,
            color: request.container.color,
          });
        }
      }

      await rebuildContextMenus();
      await refreshGate();
      return { ok: true };
    }

    case "deleteContainer": {
      if (request.containerId === DEFAULT_CONTAINER_ID) {
        throw new Error("The default container cannot be deleted.");
      }
      const state = await loadState();

      // If it happens to be mounted, hand the jar back to the default container first.
      for (const realm of state.realms) {
        if ((state.mounted[realm.id] ?? DEFAULT_CONTAINER_ID) === request.containerId) {
          await mountContainer(realm, DEFAULT_CONTAINER_ID);
        }
      }

      const fresh = await loadState();
      await saveState({
        containers: fresh.containers.filter((c) => c.id !== request.containerId),
        rules: fresh.rules.filter((r) => r.containerId !== request.containerId),
      });
      await dropVaultContainer(request.containerId);
      await rebuildContextMenus();
      await refreshGate();
      return { ok: true };
    }

    case "saveRules": {
      await saveState({ rules: request.rules });
      // A new rule should cover tabs that are already open - otherwise you would
      // have to reload them by hand for anything to happen.
      const moved = await applyRulesToOpenTabs();
      return { ok: true, moved };
    }

    case "saveRealms":
      await saveState({ realms: request.realms });
      await refreshGate();
      return { ok: true };

    case "createRealm": {
      const state = await loadState();
      const name = request.name.trim();
      if (!name) throw new Error("The realm name cannot be empty.");
      if (state.realms.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
        throw new Error("A realm with that name already exists.");
      }
      const realm: Realm = {
        id: uid(),
        name,
        hosts: request.hosts.map((h) => h.trim().toLowerCase()).filter(Boolean),
        builtin: false,
      };
      await saveState({ realms: [...state.realms, realm] });
      await refreshGate();
      return realm;
    }

    case "deleteRealm": {
      const state = await loadState();
      const realm = state.realms.find((r) => r.id === request.realmId);
      if (!realm) throw new Error("No such realm.");

      // Before the realm disappears, hand the jar back to the default container.
      // Otherwise the cookies of the mounted container would stay in the browser
      // for good, with no vault left to remember them.
      await mountContainer(realm, DEFAULT_CONTAINER_ID);

      const fresh = await loadState();
      const mounted = { ...fresh.mounted };
      delete mounted[realm.id];
      await saveState({ realms: fresh.realms.filter((r) => r.id !== realm.id), mounted });
      await dropVaultRealm(realm.id);
      await refreshGate();
      return { ok: true };
    }

    case "saveSettings":
      await saveState({ settings: request.settings });
      return { ok: true };

    case "openInContainer":
      await openInContainer(request.url, request.containerId);
      return { ok: true };

    case "getPending":
      return buildPendingInfo(request.tabId, request.url);

    case "resolveFrozen": {
      const state = await loadState();
      const container = state.containers.find((c) => c.id === request.containerId);
      if (!container) throw new Error("No such container.");

      await assignTabToContainer(request.tabId, container);
      const url = request.url ?? (await takePendingUrl(request.tabId));
      if (url) {
        const realm = realmForUrl(state.realms, url);
        if (realm && container.isolate) await mountContainer(realm, container.id);
      }

      // The gate has to be ready BEFORE the tab moves to the real address.
      await refreshGate();
      if (url) await chrome.tabs.update(request.tabId, { url });
      // Without an address the tab would sit on the picker with no explanation,
      // so we say plainly whether anything happened.
      return { ok: true, navigated: Boolean(url) };
    }

    case "saveBackup":
      await saveState({ backup: request.backup });
      await rescheduleBackup();
      return { ok: true };

    case "backupNow":
      // Interactive: this is a user click, so a consent window is appropriate.
      return runBackup(true);

    case "backupDisconnect": {
      await driveDisconnect();
      const state = await loadState();
      await saveState({ backup: { ...state.backup, enabled: false, lastError: null } });
      await rescheduleBackup();
      return { ok: true };
    }

    case "exportSnapshot":
      return buildSnapshot(request.includeCookies);

    case "importSnapshot": {
      await applySnapshot(request.snapshot as Snapshot, request.restoreWindows);
      await rebuildContextMenus();
      await refreshGate();
      return { ok: true };
    }

    default:
      throw new Error("Unknown request.");
  }
}

async function buildOverview(): Promise<Overview> {
  // A new-group event can be missed while the service worker is asleep, so we
  // close the gap every time the interface opens.
  await syncContainersWithGroups();
  const state = await loadState();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let activeTab: TabStatus | null = null;

  if (tab?.id !== undefined) {
    const byTab = await resolveAllTabs(state.containers);
    const containerId = byTab[tab.id] ?? DEFAULT_CONTAINER_ID;
    const realm = tab.url ? realmForUrl(state.realms, tab.url) : null;
    const container = state.containers.find((c) => c.id === containerId);
    const mounted = realm ? await mountedContainer(realm.id) : null;

    activeTab = {
      tabId: tab.id,
      containerId,
      realmId: realm?.id ?? null,
      frozen: Boolean(realm && container?.isolate && mounted !== containerId),
    };
  }

  return {
    state,
    activeTab,
    frozenCounts: await frozenCounts(),
    driveConfigured: driveConfigured(),
  };
}

async function buildPendingInfo(tabId: number, fromPage?: string): Promise<PendingInfo> {
  const state = await loadState();
  const url = fromPage ?? (await takePendingUrl(tabId));
  const matched = url
    ? state.rules.find((rule) => rule.enabled && ruleMatches(rule.pattern, url))
    : undefined;
  const realm = url ? realmForUrl(state.realms, url) : null;

  return {
    url,
    realmName: realm?.name ?? null,
    suggestedContainerId: matched?.containerId ?? null,
    currentContainerId: await resolveTab(tabId, state.containers),
    mountedContainerId: realm ? await mountedContainer(realm.id) : null,
    containers: state.containers,
    autoResolve: Boolean(matched),
  };
}

/** The next unused colour from the tab group palette. */
function pickColor(containers: Container[]): GroupColor {
  const used = new Set(containers.map((c) => c.color));
  return GROUP_COLORS.find((color) => !used.has(color)) ?? "blue";
}
