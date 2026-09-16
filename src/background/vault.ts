import { cookieBelongsToRealm, cookieUrl, toSetDetails, toStored } from "../shared/realms";
import { readVaultSlot, writeVaultSlot } from "../shared/storage";
import type { Realm } from "../shared/types";

/** Cookies present in the browser jar that belong to a realm. */
export async function collectRealmCookies(realm: Realm): Promise<chrome.cookies.Cookie[]> {
  const all = await chrome.cookies.getAll({});
  return all.filter((cookie) => cookieBelongsToRealm(cookie.domain, realm));
}

/** Parks the current jar contents in the vault of a container. Returns the count. */
export async function harvest(containerId: string, realm: Realm): Promise<number> {
  const cookies = await collectRealmCookies(realm);
  await writeVaultSlot(containerId, realm.id, cookies.map(toStored));
  return cookies.length;
}

/** Removes every cookie of a realm from the browser jar. */
export async function purge(realm: Realm): Promise<number> {
  const cookies = await collectRealmCookies(realm);
  await Promise.all(
    cookies.map((cookie) => {
      const details: chrome.cookies.CookieDetails = {
        url: cookieUrl(cookie),
        name: cookie.name,
      };
      if (cookie.partitionKey) details.partitionKey = cookie.partitionKey;
      return chrome.cookies.remove(details).catch(() => undefined);
    }),
  );
  return cookies.length;
}

/** Injects the cookies stored for a container back into the jar. */
export async function restore(containerId: string, realm: Realm): Promise<number> {
  const stored = await readVaultSlot(containerId, realm.id);
  let written = 0;
  for (const cookie of stored) {
    try {
      await chrome.cookies.set(toSetDetails(cookie));
      written += 1;
    } catch {
      // A single cookie can be rejected (expired, or an unsupported
      // SameSite/Secure combination). The rest of the session still has a
      // chance of working, so one failure must not abort the restore.
    }
  }
  return written;
}

/**
 * Clears site data for the hosts of a realm. Cookies alone are not enough:
 * Microsoft portals are MSAL applications and keep access tokens in
 * localStorage. Without this step a tab can keep using the token of the
 * previous tenant for about an hour after the switch.
 *
 * Wildcard patterns are skipped because the API expects concrete origins.
 */
export async function clearSiteData(realm: Realm): Promise<void> {
  const [firstOrigin, ...restOrigins] = realm.hosts
    .filter((host) => !host.startsWith("*."))
    .map((host) => `https://${host}`);
  if (firstOrigin === undefined) return;

  await chrome.browsingData.remove(
    { origins: [firstOrigin, ...restOrigins] },
    { localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true },
  );
}
