import { loadState, saveState } from "../shared/storage";
import type { BackupState } from "../shared/types";
import { uploadSnapshot } from "./drive";
import { buildSnapshot } from "./snapshot";

export const BACKUP_ALARM = "webspaces-backup";

const TARGET = { folderName: "WebSpaces", fileName: "webspaces-backup.json" };

/**
 * Uploads a copy of the configuration and the tab tree to Drive.
 *
 * Cookies are NOT included, deliberately. The file lands in the cloud
 * automatically and unattended, and sign-in sessions in plain text would give
 * anyone who takes over that Google account entry to every tenant without a
 * password and without MFA. Sessions can be restored by signing in again;
 * the configuration cannot be restored at all.
 */
export async function runBackup(interactive: boolean): Promise<BackupState> {
  const snapshot = await buildSnapshot(false);

  try {
    await uploadSnapshot(snapshot, TARGET, interactive);
    return persist({ lastAt: new Date().toISOString(), lastError: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await persist({ lastError: message });
    throw error;
  }
}

async function persist(patch: Partial<BackupState>): Promise<BackupState> {
  const state = await loadState();
  const backup: BackupState = { ...state.backup, ...patch };
  await saveState({ backup });
  return backup;
}

/** Sets or clears the recurring alarm according to the current settings. */
export async function rescheduleBackup(): Promise<void> {
  const state = await loadState();
  await chrome.alarms.clear(BACKUP_ALARM);
  if (!state.backup.enabled) return;

  const minutes = Math.max(15, state.backup.intervalMinutes);
  chrome.alarms.create(BACKUP_ALARM, {
    periodInMinutes: minutes,
    delayInMinutes: minutes,
  });
}

/**
 * The upload driven by the alarm. Deliberately non-interactive: a consent
 * window popping up on its own in the middle of work would be worse than an
 * error note in the options page.
 */
export async function runScheduledBackup(): Promise<void> {
  const state = await loadState();
  if (!state.backup.enabled) return;
  await runBackup(false).catch((error: unknown) => {
    console.error("WebSpaces: Drive backup failed", error);
  });
}
