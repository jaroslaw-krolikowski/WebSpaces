import {
  BUILTIN_REALMS,
  DEFAULT_BACKUP,
  DEFAULT_CONTAINER,
  DEFAULT_CONTAINER_ID,
  DEFAULT_SETTINGS,
} from "./types";
import type { State, StoredCookie, Vault } from "./types";

const STATE_KEY = "state";
const VAULT_KEY = "vault";
const TAB_MAP_KEY = "tabContainers";
const PENDING_KEY = "pendingUrls";
const GROUP_MAP_KEY = "groupBindings";

export function uid(): string {
  return crypto.randomUUID().slice(0, 8);
}

export async function loadState(): Promise<State> {
  const raw = await chrome.storage.local.get(STATE_KEY);
  const stored = raw[STATE_KEY] as Partial<State> | undefined;
  const containers = stored?.containers?.length ? stored.containers : [DEFAULT_CONTAINER];
  // Presets only show up until the first save. After that the realm list belongs
  // to the user, including the right to leave it empty.
  const seeded = stored?.seeded === true;

  return {
    containers: containers.some((c) => c.id === DEFAULT_CONTAINER_ID)
      ? containers
      : [DEFAULT_CONTAINER, ...containers],
    realms: seeded ? (stored?.realms ?? []) : BUILTIN_REALMS,
    rules: stored?.rules ?? [],
    settings: { ...DEFAULT_SETTINGS, ...stored?.settings },
    mounted: stored?.mounted ?? {},
    backup: { ...DEFAULT_BACKUP, ...stored?.backup },
    seeded,
  };
}

export async function saveState(patch: Partial<State>): Promise<State> {
  const current = await loadState();
  const next: State = { ...current, ...patch, seeded: true };
  if (!next.containers.some((c) => c.id === DEFAULT_CONTAINER_ID)) {
    next.containers = [DEFAULT_CONTAINER, ...next.containers];
  }
  await chrome.storage.local.set({ [STATE_KEY]: next });
  return next;
}

export async function loadVault(): Promise<Vault> {
  const raw = await chrome.storage.local.get(VAULT_KEY);
  return (raw[VAULT_KEY] as Vault | undefined) ?? {};
}

export async function readVaultSlot(containerId: string, realmId: string): Promise<StoredCookie[]> {
  const vault = await loadVault();
  return vault[containerId]?.[realmId] ?? [];
}

export async function writeVaultSlot(
  containerId: string,
  realmId: string,
  cookies: StoredCookie[],
): Promise<void> {
  const vault = await loadVault();
  const slot = vault[containerId] ?? {};
  slot[realmId] = cookies;
  vault[containerId] = slot;
  await chrome.storage.local.set({ [VAULT_KEY]: vault });
}

export async function dropVaultContainer(containerId: string): Promise<void> {
  const vault = await loadVault();
  delete vault[containerId];
  await chrome.storage.local.set({ [VAULT_KEY]: vault });
}

/** Drops the slots of a deleted realm from the vault of every container. */
export async function dropVaultRealm(realmId: string): Promise<void> {
  const vault = await loadVault();
  for (const slots of Object.values(vault)) delete slots[realmId];
  await chrome.storage.local.set({ [VAULT_KEY]: vault });
}

/* --- Tab map. Kept in storage.session because tab ids do not survive a browser
       restart anyway. --- */

export async function getTabMap(): Promise<Record<number, string>> {
  const raw = await chrome.storage.session.get(TAB_MAP_KEY);
  return (raw[TAB_MAP_KEY] as Record<number, string> | undefined) ?? {};
}

export async function setTabContainer(tabId: number, containerId: string): Promise<void> {
  const map = await getTabMap();
  map[tabId] = containerId;
  await chrome.storage.session.set({ [TAB_MAP_KEY]: map });
}

export async function clearTabContainer(tabId: number): Promise<void> {
  const map = await getTabMap();
  delete map[tabId];
  await chrome.storage.session.set({ [TAB_MAP_KEY]: map });
}

/* --- Where a tab was heading before the gate redirected it. --- */

export async function setPendingUrl(tabId: number, url: string): Promise<void> {
  const raw = await chrome.storage.session.get(PENDING_KEY);
  const map = (raw[PENDING_KEY] as Record<number, string> | undefined) ?? {};
  map[tabId] = url;
  await chrome.storage.session.set({ [PENDING_KEY]: map });
}

export async function takePendingUrl(tabId: number): Promise<string | null> {
  const raw = await chrome.storage.session.get(PENDING_KEY);
  const map = (raw[PENDING_KEY] as Record<number, string> | undefined) ?? {};
  return map[tabId] ?? null;
}

/* --- Tab group to container binding. Group ids do not survive a browser
       restart, so they live in storage.session and get rebuilt from group titles
       afterwards. An explicit binding is still needed to survive a group rename,
       after which the title no longer matches. --- */

export async function getGroupBindings(): Promise<Record<number, string>> {
  const raw = await chrome.storage.session.get(GROUP_MAP_KEY);
  return (raw[GROUP_MAP_KEY] as Record<number, string> | undefined) ?? {};
}

export async function setGroupBinding(groupId: number, containerId: string): Promise<void> {
  const map = await getGroupBindings();
  map[groupId] = containerId;
  await chrome.storage.session.set({ [GROUP_MAP_KEY]: map });
}

export async function clearGroupBinding(groupId: number): Promise<void> {
  const map = await getGroupBindings();
  delete map[groupId];
  await chrome.storage.session.set({ [GROUP_MAP_KEY]: map });
}
