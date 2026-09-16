import { refreshGate, setAuthBypass } from "./gate";

const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const AUTH_KEY = "driveAuth";

/** A token rejected by Google - the only error worth one retry. */
class ExpiredTokenError extends Error {}

export interface DriveTarget {
  folderName: string;
  fileName: string;
}

/**
 * Credentials and tokens live under their own storage key, deliberately outside
 * State. State is what configuration sync publishes, and credentials must never
 * leave this machine.
 */
interface DriveAuth {
  clientId: string;
  clientSecret: string;
  refreshToken: string | null;
  accessToken: string | null;
  /** Epoch millis; refreshed a minute early to avoid racing the expiry. */
  expiresAt: number;
}

const EMPTY: DriveAuth = {
  clientId: "",
  clientSecret: "",
  refreshToken: null,
  accessToken: null,
  expiresAt: 0,
};

export async function getAuth(): Promise<DriveAuth> {
  const raw = await chrome.storage.local.get(AUTH_KEY);
  return { ...EMPTY, ...(raw[AUTH_KEY] as Partial<DriveAuth> | undefined) };
}

async function saveAuth(patch: Partial<DriveAuth>): Promise<DriveAuth> {
  const next = { ...(await getAuth()), ...patch };
  await chrome.storage.local.set({ [AUTH_KEY]: next });
  return next;
}

export async function saveCredentials(clientId: string, clientSecret: string): Promise<void> {
  // Changing the client invalidates any token issued by the previous one.
  await saveAuth({
    clientId: clientId.trim(),
    clientSecret: clientSecret.trim(),
    refreshToken: null,
    accessToken: null,
    expiresAt: 0,
  });
}

/** The address Google must accept as the redirect target for this extension. */
export function redirectUri(): string {
  return `https://${chrome.runtime.id}.chromiumapp.org/`;
}

export async function isConfigured(): Promise<boolean> {
  const auth = await getAuth();
  return Boolean(auth.clientId && auth.clientSecret);
}

export async function isConnected(): Promise<boolean> {
  return Boolean((await getAuth()).refreshToken);
}

/* --- Authorisation code flow with PKCE --- */

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

async function postToken(body: Record<string, string>): Promise<Record<string, unknown>> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const detail = String(data["error_description"] ?? data["error"] ?? response.status);
    throw new Error(`Google refused the token exchange: ${detail}`);
  }
  return data;
}

/**
 * Runs the consent flow and stores the refresh token.
 *
 * Unlike getAuthToken this opens a real Google sign-in page, which has two
 * consequences we have to handle rather than ignore. The page sits on a realm
 * host, so the gate would redirect it to the container picker and the flow would
 * never finish - hence the temporary bypass. And signing in writes Google
 * cookies into whichever container is mounted, which the caller warns about,
 * because silently reshuffling the user containers would be worse.
 */
export async function connect(): Promise<void> {
  const auth = await getAuth();
  if (!auth.clientId || !auth.clientSecret) {
    throw new Error("Paste the client ID and client secret first.");
  }

  const { verifier, challenge } = await pkcePair();
  const url =
    `${AUTH_ENDPOINT}?client_id=${encodeURIComponent(auth.clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri())}` +
    `&response_type=code&access_type=offline&prompt=consent` +
    `&scope=${encodeURIComponent(SCOPE)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256`;

  setAuthBypass(true);
  await refreshGate();
  let redirect: string | undefined;
  try {
    redirect = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  } finally {
    setAuthBypass(false);
    await refreshGate();
  }

  if (!redirect) {
    throw new Error(
      "The consent window closed before finishing. If it showed Error 403 access_denied, the " +
        "app is still in Testing publishing status: press Publish app on the Audience page in " +
        "Google Cloud. No review is needed, drive.file is a non-sensitive scope.",
    );
  }

  const params = new URL(redirect).searchParams;
  const error = params.get("error");
  if (error === "access_denied") {
    throw new Error(
      "Google refused the consent. Either the app is still in Testing publishing status and " +
        "this account is not a test user, or you declined. Publishing the app on the Audience " +
        "page fixes the first case and needs no review.",
    );
  }
  if (error) throw new Error(`Google returned: ${error}`);

  const code = params.get("code");
  if (!code) throw new Error("Google returned no authorisation code.");

  const data = await postToken({
    client_id: auth.clientId,
    client_secret: auth.clientSecret,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(),
  });

  const refresh = data["refresh_token"];
  if (typeof refresh !== "string") {
    throw new Error("Google issued no refresh token. Remove the app at myaccount.google.com and retry.");
  }
  await saveAuth({
    refreshToken: refresh,
    accessToken: String(data["access_token"] ?? ""),
    expiresAt: Date.now() + Number(data["expires_in"] ?? 0) * 1000,
  });
}

export async function disconnect(): Promise<void> {
  await saveAuth({ refreshToken: null, accessToken: null, expiresAt: 0 });
}

/** A usable access token, refreshed when the stored one is close to expiry. */
async function accessToken(): Promise<string> {
  const auth = await getAuth();
  if (!auth.refreshToken) throw new Error("Google Drive is not connected yet.");
  if (auth.accessToken && auth.expiresAt > Date.now() + 60_000) return auth.accessToken;

  const data = await postToken({
    client_id: auth.clientId,
    client_secret: auth.clientSecret,
    refresh_token: auth.refreshToken,
    grant_type: "refresh_token",
  });
  const token = String(data["access_token"] ?? "");
  if (!token) throw new Error("Google returned no access token.");
  await saveAuth({ accessToken: token, expiresAt: Date.now() + Number(data["expires_in"] ?? 0) * 1000 });
  return token;
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
    const token = await accessToken();
    try {
      const folderId = await ensureFolder(token, target.folderName);
      const existing = await findFile(token, folderId, target.fileName);
      await writeJson(token, folderId, target.fileName, snapshot, existing);
      return;
    } catch (error) {
      // Access tokens get revoked on the Google side after a password change or
      // a device sign-out. One retry with a fresh one, then the error goes up.
      if (attempt === 0 && error instanceof ExpiredTokenError) {
        await saveAuth({ accessToken: null, expiresAt: 0 });
        continue;
      }
      throw error;
    }
  }
}
