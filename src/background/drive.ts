const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";

/** A token revoked on the Google side - the only error worth retrying. */
class ExpiredTokenError extends Error {}

export interface DriveTarget {
  folderName: string;
  fileName: string;
}

/** Whether an OAuth client id was injected into this build. */
export function isConfigured(): boolean {
  const manifest = chrome.runtime.getManifest() as chrome.runtime.ManifestV3 & {
    oauth2?: { client_id?: string };
  };
  return Boolean(manifest.oauth2?.client_id);
}

/**
 * A token for the account signed into this Chrome profile. It opens no sign-in
 * page: the whole exchange goes through an internal browser mechanism. That has
 * two consequences worth knowing - the DNR gate has nothing to intercept, and
 * nothing lands in the cookie jar that could pollute the vault of the container
 * currently mounted.
 */
async function getToken(interactive: boolean): Promise<string> {
  if (!isConfigured()) {
    throw new Error(
      "This build has no OAuth client id. See README, section Google Drive backup.",
    );
  }
  try {
    const result = await chrome.identity.getAuthToken({ interactive });
    if (!result?.token) throw new Error("");
    return result.token;
  } catch (cause) {
    throw new Error(describeAuthFailure(cause, interactive));
  }
}

function describeAuthFailure(cause: unknown, interactive: boolean): string {
  const raw = cause instanceof Error ? cause.message : String(cause ?? "");
  if (/not signed in/i.test(raw)) {
    return "This Chrome profile is not signed into a Google account. Sign in and try again.";
  }
  if (/revoked|not granted|interaction required/i.test(raw) || !interactive) {
    return "Drive access expired or was never granted. Use the Connect to Google Drive button.";
  }
  if (/client|invalid|bad.?client/i.test(raw)) {
    return "The OAuth client id does not match this extension. Check the extension id in Google Cloud.";
  }
  return raw || "Chrome returned no Google token.";
}

/** Drops the consent stored by Chrome - the next upload asks for it again. */
export async function disconnect(): Promise<void> {
  const result = await chrome.identity.getAuthToken({ interactive: false }).catch(() => null);
  if (result?.token) await chrome.identity.removeCachedAuthToken({ token: result.token });
}

async function api(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  if (response.status === 401) throw new ExpiredTokenError("Token expired.");
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Google Drive answered ${response.status}. ${detail}`);
  }
  return response;
}

/** An apostrophe in a name would break the Drive query - the only char to escape. */
function quote(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function ensureFolder(token: string, name: string): Promise<string> {
  const query = encodeURIComponent(
    `name = '${quote(name)}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
  );
  const found = await api(token, `${DRIVE_FILES}?q=${query}&fields=files(id)&pageSize=1`);
  const existing = ((await found.json()) as { files?: { id: string }[] }).files?.[0]?.id;
  if (existing) return existing;

  const created = await api(token, `${DRIVE_FILES}?fields=id`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
  });
  return ((await created.json()) as { id: string }).id;
}

async function findFile(token: string, folderId: string, name: string): Promise<string | null> {
  const query = encodeURIComponent(
    `name = '${quote(name)}' and '${folderId}' in parents and trashed = false`,
  );
  const response = await api(token, `${DRIVE_FILES}?q=${query}&fields=files(id)&pageSize=1`);
  return ((await response.json()) as { files?: { id: string }[] }).files?.[0]?.id ?? null;
}

async function writeJson(
  token: string,
  folderId: string,
  name: string,
  payload: unknown,
  fileId: string | null,
): Promise<string> {
  const body = JSON.stringify(payload, null, 2);

  if (fileId) {
    const updated = await api(token, `${DRIVE_UPLOAD}/${fileId}?uploadType=media&fields=id`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return ((await updated.json()) as { id: string }).id;
  }

  // Creating a file needs multipart: one part for metadata, one for content.
  const boundary = `webspaces-${crypto.randomUUID()}`;
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify({ name, parents: [folderId] })}\r\n` +
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${body}\r\n--${boundary}--`;

  const created = await api(token, `${DRIVE_UPLOAD}?uploadType=multipart&fields=id`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body: multipart,
  });
  return ((await created.json()) as { id: string }).id;
}

/**
 * Uploads a snapshot to Drive, overwriting the previous version of the same
 * file. Version history stays on the Drive side, so we do not multiply files
 * stamped with dates.
 */
export async function uploadSnapshot(
  snapshot: unknown,
  target: DriveTarget,
  interactive: boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await getToken(interactive);
    try {
      const folderId = await ensureFolder(token, target.folderName);
      const existing = await findFile(token, folderId, target.fileName);
      await writeJson(token, folderId, target.fileName, snapshot, existing);
      return;
    } catch (error) {
      // Consent gets revoked on the Google side (password change, device
      // sign-out). One retry with a fresh token, then the error goes up.
      if (attempt === 0 && error instanceof ExpiredTokenError) {
        await chrome.identity.removeCachedAuthToken({ token });
        continue;
      }
      throw error;
    }
  }
}
