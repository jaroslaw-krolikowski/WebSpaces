const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const CLIENT_ID_KEY = "pastedClientId";
const CONNECTED_KEY = "driveConnectedAt";

/** A token rejected by Google - the only error worth one retry. */
class ExpiredTokenError extends Error {}

export interface DriveTarget {
  folderName: string;
  fileName: string;
}

/**
 * The client id Chrome will use. It has to sit in the manifest: getAuthToken
 * reads it from there and offers no way to pass one at runtime. That is the
 * single reason the setup ends with a rebuild.
 */
export function manifestClientId(): string {
  const manifest = chrome.runtime.getManifest() as chrome.runtime.ManifestV3 & {
    oauth2?: { client_id?: string };
  };
  return manifest.oauth2?.client_id ?? "";
}

export function isConfigured(): boolean {
  return Boolean(manifestClientId());
}

/**
 * What the user typed into the panel, kept so the field survives a reload and
 * so the setup can hand back a ready command. The manifest stays the source of
 * truth for what Chrome actually uses.
 */
export async function getPastedClientId(): Promise<string> {
  const raw = await chrome.storage.local.get(CLIENT_ID_KEY);
  return (raw[CLIENT_ID_KEY] as string | undefined) ?? "";
}

export async function savePastedClientId(clientId: string): Promise<void> {
  await chrome.storage.local.set({ [CLIENT_ID_KEY]: clientId.trim() });
}

export async function isConnected(): Promise<boolean> {
  const raw = await chrome.storage.local.get(CONNECTED_KEY);
  return Boolean(raw[CONNECTED_KEY]);
}

/**
 * A token for the account signed into this Chrome profile.
 *
 * No sign-in page is opened: the exchange runs inside the browser. That is why
 * the isolation gate has nothing to intercept and why nothing lands in the
 * cookie jar to pollute the mounted container vault.
 */
async function getToken(interactive: boolean): Promise<string> {
  if (!isConfigured()) {
    throw new Error(
      "This build has no client id in its manifest. Finish the setup steps below.",
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
  if (/access_denied|403/i.test(raw)) {
    return (
      "Google refused the consent. The app is most likely still in Testing publishing status, " +
      "which only admits accounts on the test user list. Publish it on the Audience page, or " +
      "add this account as a test user."
    );
  }
  if (/bad client id|invalid_client|OAuth2 request failed/i.test(raw)) {
    return (
      "Google does not recognise this client id for this extension. Check that the OAuth client " +
      "is of type Chrome Extension and carries the extension id shown in step 1."
    );
  }
  if (/revoked|not granted|user did not approve/i.test(raw) || !interactive) {
    return "Drive access was not granted. Use the Connect button to ask again.";
  }
  return raw || "Chrome returned no Google token.";
}

/** Runs the consent prompt once and remembers that it succeeded. */
export async function connect(): Promise<void> {
  await getToken(true);
  await chrome.storage.local.set({ [CONNECTED_KEY]: new Date().toISOString() });
}

/** Drops the token Chrome cached, so the next upload asks for consent again. */
export async function disconnect(): Promise<void> {
  const result = await chrome.identity.getAuthToken({ interactive: false }).catch(() => null);
  if (result?.token) await chrome.identity.removeCachedAuthToken({ token: result.token });
  await chrome.storage.local.remove(CONNECTED_KEY);
}

/* --- Drive REST --- */

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
): Promise<void> {
  const body = JSON.stringify(payload, null, 2);

  if (fileId) {
    await api(token, `${DRIVE_UPLOAD}/${fileId}?uploadType=media&fields=id`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return;
  }

  // Creating a file needs multipart: one part for metadata, one for content.
  const boundary = `webspaces-${crypto.randomUUID()}`;
  const multipart =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify({ name, parents: [folderId] })}\r\n` +
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${body}\r\n--${boundary}--`;

  await api(token, `${DRIVE_UPLOAD}?uploadType=multipart&fields=id`, {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body: multipart,
  });
}

/**
 * Uploads a snapshot, overwriting the previous version of the same file.
 * Version history stays on the Drive side, so we do not multiply dated copies.
 */
export async function uploadSnapshot(snapshot: unknown, target: DriveTarget): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await getToken(false);
    try {
      const folderId = await ensureFolder(token, target.folderName);
      const existing = await findFile(token, folderId, target.fileName);
      await writeJson(token, folderId, target.fileName, snapshot, existing);
      return;
    } catch (error) {
      // Cached tokens go stale after a password change or a device sign-out.
      // One retry with a fresh one, then the error goes up.
      if (attempt === 0 && error instanceof ExpiredTokenError) {
        await chrome.identity.removeCachedAuthToken({ token });
        continue;
      }
      throw error;
    }
  }
}
