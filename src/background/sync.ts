import { loadState, saveState } from "../shared/storage";
import type { Container, Realm, Rule, Settings, SyncState } from "../shared/types";

/**
 * Configuration sync through chrome.storage.sync.
 *
 * This is the zero-setup path: Chrome carries the data over the account the
 * profile is already signed into, with no OAuth, no Google Cloud project and no
 * client id. It only covers configuration, which is the part that belongs on
 * every machine. Windows and tabs stay out because they are device specific and
 * would not fit the quota anyway, and cookies stay out for the same reason they
 * stay out of the Drive backup.
 *
 * Conflict resolution is last writer wins over the whole payload. For a personal
 * tool that is predictable enough, and anything finer would need per-field
 * timestamps for very little gain.
 */

const META_KEY = "meta";
const CHUNK_PREFIX = "config";
const INSTANCE_KEY = "instanceId";

/** storage.sync caps a single item at 8 KB, so the payload is split below that. */
const CHUNK_SIZE = 6000;

interface SyncedConfig {
  containers: Container[];
  realms: Realm[];
  rules: Rule[];
  settings: Settings;
}

interface SyncMeta {
  writer: string;
  at: number;
  chunks: number;
}

/**
 * Writes land in our own storage too, so without knowing which device wrote
 * last we would apply our own push back to ourselves and loop forever.
 */
async function instanceId(): Promise<string> {
  const raw = await chrome.storage.local.get(INSTANCE_KEY);
  const existing = raw[INSTANCE_KEY] as string | undefined;
  if (existing) return existing;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ [INSTANCE_KEY]: fresh });
  return fresh;
}

async function record(patch: Partial<SyncState>): Promise<void> {
  const state = await loadState();
  await saveState({ sync: { ...state.sync, ...patch } });
}

export async function pushToSync(): Promise<void> {
  const state = await loadState();
  if (!state.settings.syncEnabled) return;

  const payload: SyncedConfig = {
    containers: state.containers,
    realms: state.realms,
    rules: state.rules,
    settings: state.settings,
  };
  const text = JSON.stringify(payload);
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE) chunks.push(text.slice(i, i + CHUNK_SIZE));

  const items: Record<string, unknown> = {
    [META_KEY]: { writer: await instanceId(), at: Date.now(), chunks: chunks.length },
  };
  chunks.forEach((chunk, index) => {
    items[`${CHUNK_PREFIX}${index}`] = chunk;
  });

  try {
    const existing = await chrome.storage.sync.get(null);

    // Writing an identical payload is what breaks the ping-pong: a device that
    // just applied a remote change saves it locally, which would otherwise
    // trigger its own push and bounce the change back to the sender forever.
    if (assemble(existing) === text) return;

    // A payload that shrank leaves orphan chunks behind, and a stale tail would
    // corrupt the next read, so they go before the new ones land.
    const stale = Object.keys(existing).filter(
      (key) =>
        key.startsWith(CHUNK_PREFIX) && Number(key.slice(CHUNK_PREFIX.length)) >= chunks.length,
    );
    if (stale.length > 0) await chrome.storage.sync.remove(stale);

    await chrome.storage.sync.set(items);
    await record({ lastAt: new Date().toISOString(), lastError: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await record({
      lastError: /quota/i.test(message)
        ? "Configuration exceeded the Chrome sync quota of 100 KB. Trim a realm host list."
        : message,
    });
  }
}

/** Rebuilds the stored payload, or an empty string when it is absent or torn. */
function assemble(all: Record<string, unknown>): string {
  const meta = all[META_KEY] as SyncMeta | undefined;
  if (!meta || typeof meta.chunks !== "number" || meta.chunks === 0) return "";

  let text = "";
  for (let index = 0; index < meta.chunks; index += 1) {
    const part = all[`${CHUNK_PREFIX}${index}`] as string | undefined;
    // A half-delivered payload is worse than none, so it counts as absent.
    if (part === undefined) return "";
    text += part;
  }
  return text;
}

/** Reads the shared configuration, if any device has written one. */
export async function pullFromSync(): Promise<boolean> {
  const all = await chrome.storage.sync.get(null);
  const meta = all[META_KEY] as SyncMeta | undefined;
  const text = assemble(all);
  if (!meta || !text) return false;

  try {
    const config = JSON.parse(text) as SyncedConfig;
    await saveState({
      containers: config.containers,
      realms: config.realms,
      rules: config.rules,
      settings: config.settings,
    });
    await record({ lastAt: new Date(meta.at).toISOString(), lastError: null });
    return true;
  } catch {
    await record({ lastError: "The synced configuration could not be read." });
    return false;
  }
}

/** True when the change came from another device and is worth applying. */
export async function isForeignChange(
  changes: Record<string, chrome.storage.StorageChange>,
): Promise<boolean> {
  const meta = changes[META_KEY]?.newValue as SyncMeta | undefined;
  if (!meta?.writer) return false;
  return meta.writer !== (await instanceId());
}

/** Clears the shared configuration without touching what is on this device. */
export async function clearSync(): Promise<void> {
  await chrome.storage.sync.clear();
  await record({ lastAt: null, lastError: null });
}
