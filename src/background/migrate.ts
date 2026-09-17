import { loadState, saveState } from "../shared/storage";
import { BUILTIN_REALMS } from "../shared/types";

/**
 * Carries preset changes into realm lists that are already stored.
 *
 * `BUILTIN_REALMS` seeds a profile once. After the first save the realm list
 * belongs to the user, which is right for edits but wrong for a preset that was
 * simply incomplete: Microsoft moved its apps to `*.cloud.microsoft` and nothing
 * in an existing installation would ever learn about it. The hosts would stay
 * ungated and unswapped, so every container shared one session on them - the
 * exact failure the extension exists to prevent.
 *
 * The rules that keep this from trampling anyone's configuration:
 *
 * - hosts are only ever **added**, never removed or reordered
 * - only to a realm that is still present and still carries its `builtin` flag
 * - a realm the user deleted stays deleted
 * - each step runs once per device and is recorded, so a host deleted after the
 *   upgrade does not come back
 */

const MARKER_KEY = "migrations";
const PRESET_HOSTS_STEP = "preset-hosts-1";

async function done(step: string): Promise<boolean> {
  const raw = await chrome.storage.local.get(MARKER_KEY);
  const marks = (raw[MARKER_KEY] as string[] | undefined) ?? [];
  return marks.includes(step);
}

async function mark(step: string): Promise<void> {
  const raw = await chrome.storage.local.get(MARKER_KEY);
  const marks = (raw[MARKER_KEY] as string[] | undefined) ?? [];
  if (marks.includes(step)) return;
  await chrome.storage.local.set({ [MARKER_KEY]: [...marks, step] });
}

/** Returns how many hosts were added, for the log line. */
export async function upgradePresetHosts(): Promise<number> {
  if (await done(PRESET_HOSTS_STEP)) return 0;

  const state = await loadState();
  let added = 0;

  const realms = state.realms.map((realm) => {
    if (!realm.builtin) return realm;
    const preset = BUILTIN_REALMS.find((p) => p.id === realm.id);
    if (!preset) return realm;

    const present = new Set(realm.hosts.map((host) => host.toLowerCase()));
    const missing = preset.hosts.filter((host) => !present.has(host.toLowerCase()));
    if (missing.length === 0) return realm;

    added += missing.length;
    return { ...realm, hosts: [...realm.hosts, ...missing] };
  });

  if (added > 0) {
    await saveState({ realms });
    console.info(
      `WebSpaces: added ${added} host(s) to the bundled realms. Microsoft moved its apps to ` +
        "*.cloud.microsoft, which was not isolated before. Settings > Realms shows the full list.",
    );
  }
  await mark(PRESET_HOSTS_STEP);
  return added;
}
