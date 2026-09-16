import { PENDING_PARAM, realmRequestDomains } from "../shared/realms";
import { loadState } from "../shared/storage";
import { DEFAULT_CONTAINER_ID } from "../shared/types";
import { resolveAllTabs } from "./tabs";

const FROZEN_PAGE = "/ui/frozen.html";

/** DNR has no shorthand for "any resource", so the types have to be listed. */
const ALL_RESOURCES = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "other",
];
const SUBRESOURCES = ALL_RESOURCES.filter((type) => type !== "main_frame");

/**
 * Recomputes every session rule from scratch. Three priority layers:
 *
 *   1. redirect — any top-level navigation to a realm host lands on the picker,
 *   2. allow    — unless the tab belongs to the container currently mounted,
 *   3. block    — and tabs of foreign containers cannot send even a subresource.
 *
 * Layer three is the important one: without it, a tenant tab left in the
 * background would keep polling Microsoft and rotate the ESTSAUTH of the mounted
 * tenant, quietly breaking both sessions at once.
 */
export async function refreshGate(): Promise<void> {
  const state = await loadState();
  const byTab = await resolveAllTabs(state.containers);
  const isolating = new Set(state.containers.filter((c) => c.isolate).map((c) => c.id));
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const removeRuleIds = existing.map((rule) => rule.id);

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds,
      addRules: buildRules(state, byTab, isolating, true),
    });
  } catch (error) {
    // Carrying the address relies on a regex substitution. If Chrome ever
    // rejects it, a gate without the address beats no gate at all — isolation
    // matters more than the convenience of the picker.
    console.error("WebSpaces: gate with carried address rejected, falling back", error);
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds,
      addRules: buildRules(state, byTab, isolating, false),
    });
  }
}

/**
 * @param carryUrl whether the redirect should append the original address to
 *   the picker. Without it the picker has no idea where the tab was heading,
 *   and after a container is chosen there is nowhere to send the tab.
 */
function buildRules(
  state: Awaited<ReturnType<typeof loadState>>,
  byTab: Record<number, string>,
  isolating: Set<string>,
  carryUrl: boolean,
): chrome.declarativeNetRequest.Rule[] {
  const frozenPage = chrome.runtime.getURL(FROZEN_PAGE);
  const rules: unknown[] = [];
  let nextId = 1;

  for (const realm of state.realms) {
    const requestDomains = realmRequestDomains(realm);
    if (requestDomains.length === 0) continue;
    const mounted = state.mounted[realm.id] ?? DEFAULT_CONTAINER_ID;

    const allowed: number[] = [];
    const frozen: number[] = [];
    for (const [rawTabId, containerId] of Object.entries(byTab)) {
      const tabId = Number(rawTabId);
      // A container with isolation off sits this one out — its tabs simply use
      // whatever happens to be in the jar.
      if (!isolating.has(containerId) || containerId === mounted) allowed.push(tabId);
      else frozen.push(tabId);
    }

    rules.push({
      id: nextId++,
      priority: 1,
      action: carryUrl
        ? // The backreference substitutes the whole matched address, so the
          // picker receives it directly in its own location — no reliance on the
          // service worker having stored it beforehand.
          {
            type: "redirect",
            redirect: { regexSubstitution: `${frozenPage}?${PENDING_PARAM}=\\0` },
          }
        : { type: "redirect", redirect: { extensionPath: FROZEN_PAGE } },
      condition: carryUrl
        ? { requestDomains, regexFilter: "^https?://.*", resourceTypes: ["main_frame"] }
        : { requestDomains, resourceTypes: ["main_frame"] },
    });

    if (allowed.length > 0) {
      rules.push({
        id: nextId++,
        priority: 2,
        action: { type: "allow" },
        condition: { tabIds: allowed, requestDomains, resourceTypes: ALL_RESOURCES },
      });
    }

    // Requests that belong to no tab: downloads taken over by the download
    // manager, fetches from a page service worker. They cannot be attributed to
    // a container, so blocking them breaks downloads without buying isolation
    // we do not have at this layer anyway (see the limits section in README).
    rules.push({
      id: nextId++,
      priority: 2,
      action: { type: "allow" },
      condition: {
        tabIds: [chrome.tabs.TAB_ID_NONE],
        requestDomains,
        resourceTypes: ALL_RESOURCES,
      },
    });

    if (frozen.length > 0) {
      rules.push({
        id: nextId++,
        priority: 3,
        action: { type: "block" },
        condition: { tabIds: frozen, requestDomains, resourceTypes: SUBRESOURCES },
      });
    }
  }

  return rules as chrome.declarativeNetRequest.Rule[];
}

/** How many tabs are frozen, broken down by realm. */
export async function frozenCounts(): Promise<Record<string, number>> {
  const state = await loadState();
  const byTab = await resolveAllTabs(state.containers);
  const isolating = new Set(state.containers.filter((c) => c.isolate).map((c) => c.id));
  const counts: Record<string, number> = {};

  for (const realm of state.realms) {
    const mounted = state.mounted[realm.id] ?? DEFAULT_CONTAINER_ID;
    counts[realm.id] = Object.values(byTab).filter(
      (containerId) => isolating.has(containerId) && containerId !== mounted,
    ).length;
  }
  return counts;
}

let pending: ReturnType<typeof setTimeout> | null = null;

/** Batched refresh — tab events tend to arrive in bursts. */
export function scheduleGateRefresh(): void {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    void refreshGate();
  }, 150);
}
