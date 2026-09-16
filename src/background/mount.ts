import { cookieBelongsToRealm } from "../shared/realms";
import { loadState, saveState } from "../shared/storage";
import { DEFAULT_CONTAINER_ID } from "../shared/types";
import type { Realm } from "../shared/types";
import { clearSiteData, harvest, purge, restore } from "./vault";

/**
 * Swapping cookies fires chrome.cookies.onChanged by itself. Without this flag
 * the write-through harvester would fill the vault with garbage mid-switch.
 */
let swapping = false;

export function isSwapping(): boolean {
  return swapping;
}

/** Which container currently owns the jar for a given realm. */
export async function mountedContainer(realmId: string): Promise<string> {
  const state = await loadState();
  return state.mounted[realmId] ?? DEFAULT_CONTAINER_ID;
}

/**
 * Switches a realm over to the given container: parks the current session,
 * clears the jar, and injects the stored one. The order matters - clearing
 * before writing guarantees no leftovers from the previous tenant.
 */
export async function mountContainer(realm: Realm, containerId: string): Promise<boolean> {
  const current = await mountedContainer(realm.id);
  if (current === containerId) return false;

  swapping = true;
  try {
    await harvest(current, realm);
    await purge(realm);
    if ((await loadState()).settings.clearSiteDataOnSwitch) await clearSiteData(realm);
    await restore(containerId, realm);
    const state = await loadState();
    await saveState({ mounted: { ...state.mounted, [realm.id]: containerId } });
  } finally {
    swapping = false;
  }
  return true;
}

/* --- Write-through: every cookie change inside the mounted realm reaches the
       vault, so an abrupt browser exit does not lose the session. --- */

const pendingRealms = new Set<string>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export async function noteCookieChange(
  cookie: chrome.cookies.Cookie,
  realms: Realm[],
): Promise<void> {
  if (swapping) return;
  const realm = realms.find((r) => cookieBelongsToRealm(cookie.domain, r));
  if (!realm) return;

  pendingRealms.add(realm.id);
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flushPending(realms), 800);
}

async function flushPending(realms: Realm[]): Promise<void> {
  flushTimer = null;
  const ids = [...pendingRealms];
  pendingRealms.clear();
  for (const realmId of ids) {
    const realm = realms.find((r) => r.id === realmId);
    if (!realm || swapping) continue;
    const containerId = await mountedContainer(realmId);
    await harvest(containerId, realm);
  }
}
