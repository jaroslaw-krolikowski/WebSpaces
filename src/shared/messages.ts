import type { Container, Realm, Rule, Settings, State } from "./types";

/** A snapshot: containers, realms, rules, and the window/tab tree. */
export interface Snapshot {
  format: "webspaces-snapshot";
  version: 1;
  savedAt: string;
  containers: Container[];
  realms: Realm[];
  rules: Rule[];
  windows: SnapshotWindow[];
  /** Present only when the user explicitly opted into exporting cookies. */
  vault?: Record<string, Record<string, unknown[]>>;
}

export interface SnapshotWindow {
  incognito: boolean;
  groups: SnapshotGroup[];
}

export interface SnapshotGroup {
  /** null for tabs outside any group. */
  containerName: string | null;
  color: string | null;
  collapsed: boolean;
  tabs: SnapshotTab[];
}

export interface SnapshotTab {
  url: string;
  title: string;
  pinned: boolean;
}

export interface TabStatus {
  tabId: number;
  containerId: string;
  realmId: string | null;
  /** The tab belongs to a container other than the mounted one, so it is blocked. */
  frozen: boolean;
}

export type Request =
  | { type: "getOverview" }
  | { type: "mount"; realmId: string; containerId: string }
  | { type: "assignTab"; tabId: number; containerId: string }
  | { type: "createContainer"; name: string; color: string }
  | { type: "updateContainer"; container: Container }
  | { type: "deleteContainer"; containerId: string }
  | { type: "saveRules"; rules: Rule[] }
  | { type: "saveRealms"; realms: Realm[] }
  | { type: "createRealm"; name: string; hosts: string[] }
  | { type: "deleteRealm"; realmId: string }
  | { type: "saveSettings"; settings: Settings }
  | { type: "clearSync" }
  | { type: "openInContainer"; url: string; containerId: string }
  // The url comes from the address of the picker page itself: the gate appends
  // it to the redirect, so it never depends on the service worker having stored it.
  | { type: "getPending"; tabId: number; url?: string }
  | { type: "resolveFrozen"; tabId: number; containerId: string; url?: string }
  | { type: "exportSnapshot"; includeCookies: boolean }
  | { type: "importSnapshot"; snapshot: Snapshot; restoreWindows: boolean };

export interface Overview {
  state: State;
  activeTab: TabStatus | null;
  /** How many tabs are currently frozen, per realm. */
  frozenCounts: Record<string, number>;
}

/** Data for the container picker that a blocked tab lands on. */
export interface PendingInfo {
  url: string | null;
  realmName: string | null;
  suggestedContainerId: string | null;
  currentContainerId: string;
  mountedContainerId: string | null;
  containers: Container[];
  /** A rule matched, so the picker should click itself through. */
  autoResolve: boolean;
}

/**
 * Sends a request to the service worker and turns every failure into a throw.
 * Without this, an error in the background ends as silence in the interface:
 * sendMessage rejects, .then never runs, and nothing happens at all.
 */
export async function send<T>(request: Request): Promise<T> {
  let response: unknown;
  try {
    response = await chrome.runtime.sendMessage(request);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `No connection to the service worker (${reason}). ` +
        "Open chrome://extensions, find WebSpaces and check the Service worker console.",
    );
  }

  if (response === undefined) {
    throw new Error(
      "The service worker sent no response. Check its console under chrome://extensions.",
    );
  }
  if (response !== null && typeof response === "object" && "error" in response) {
    throw new Error(String((response as { error: unknown }).error));
  }
  return response as T;
}
