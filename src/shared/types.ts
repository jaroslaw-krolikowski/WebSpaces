/** Colours Chrome's native tab groups accept - no other value is valid. */
export type GroupColor =
  | "grey"
  | "blue"
  | "red"
  | "yellow"
  | "green"
  | "pink"
  | "purple"
  | "cyan"
  | "orange";

export const GROUP_COLORS: readonly GroupColor[] = [
  "blue",
  "cyan",
  "green",
  "yellow",
  "orange",
  "red",
  "pink",
  "purple",
  "grey",
];

/**
 * Pseudo-container for tabs that belong to no group.
 * It exists so ordinary browsing keeps a vault of its own instead of being
 * overwritten the first time a real container is mounted.
 */
export const DEFAULT_CONTAINER_ID = "default";

export interface Container {
  id: string;
  /** Doubles as the tab group title, so it has to be unique. */
  name: string;
  color: GroupColor;
  /** Whether the container keeps its own cookies. Off means it acts like the default. */
  isolate: boolean;
  createdAt: number;
}

/**
 * A realm is a set of hosts whose cookies collide between containers.
 *
 * All of Microsoft SSO is one realm, because the ESTSAUTH cookie on
 * login.microsoftonline.com is shared by every tenant. Hosts outside a realm are
 * never touched, which is why two different <tenant>.sharepoint.com tabs can
 * stay open side by side.
 */
export interface Realm {
  id: string;
  name: string;
  /** Patterns: "login.microsoftonline.com" or "*.office.com". */
  hosts: string[];
  builtin: boolean;
}

/** "Always open this address in that container." */
export interface Rule {
  id: string;
  /** Simplified glob over host and path, e.g. "*.sharepoint.com/*". */
  pattern: string;
  containerId: string;
  enabled: boolean;
}

/** chrome.cookies.Cookie reshaped into something we can persist. */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: `${chrome.cookies.SameSiteStatus}`;
  hostOnly: boolean;
  session: boolean;
  expirationDate?: number;
  partitionKey?: chrome.cookies.CookiePartitionKey;
}

export interface Settings {
  /** Switch containers automatically when a tab is activated. */
  autoMountOnFocus: boolean;
  /** Show the container picker when no rule matches. */
  showInterstitial: boolean;
  /** Clear localStorage and IndexedDB for realm hosts when switching containers. */
  clearSiteDataOnSwitch: boolean;
  /** Carry the configuration between Chrome profiles through chrome.storage.sync. */
  syncEnabled: boolean;
}

export interface State {
  containers: Container[];
  realms: Realm[];
  rules: Rule[];
  settings: Settings;
  /** Which container currently owns the browser cookie jar, per realm. */
  mounted: Record<string, string>;
  /**
   * Whether the presets have been seeded once. Without this flag, deleting every
   * realm would resurrect them on the next read of the state.
   */
  seeded: boolean;
  backup: BackupState;
  sync: SyncState;
  setup: SetupState;
}

/** How far the guided Google Drive setup has been taken. */
export interface SetupState {
  /**
   * Highest step finished, 0 to 7. Steps one to five cannot be verified from
   * here because they happen inside Google Cloud, so they advance on the click
   * that opens them. The last two are derived from real state instead.
   */
  completed: number;
}

/** State of the zero-setup configuration sync through chrome.storage.sync. */
export interface SyncState {
  /** Timestamp of the last successful exchange, ISO 8601. */
  lastAt: string | null;
  lastError: string | null;
}

/** Google Drive backup state. */
export interface BackupState {
  enabled: boolean;
  intervalMinutes: number;
  /** Timestamp of the last successful upload, ISO 8601. */
  lastAt: string | null;
  /** Why the last attempt failed; surfaced in the options page. */
  lastError: string | null;
}

/** vault[containerId][realmId] = cookies parked for later. */
export type Vault = Record<string, Record<string, StoredCookie[]>>;

export const DEFAULT_SETTINGS: Settings = {
  autoMountOnFocus: true,
  showInterstitial: true,
  clearSiteDataOnSwitch: true,
  syncEnabled: true,
};

export const DEFAULT_SYNC: SyncState = {
  lastAt: null,
  lastError: null,
};

export const DEFAULT_SETUP: SetupState = { completed: 0 };

export const DEFAULT_BACKUP: BackupState = {
  enabled: false,
  intervalMinutes: 60,
  lastAt: null,
  lastError: null,
};

export const DEFAULT_CONTAINER: Container = {
  id: DEFAULT_CONTAINER_ID,
  name: "Default",
  color: "grey",
  isolate: true,
  createdAt: 0,
};

/**
 * Realm presets - a starting point, not a closed list. Each one can be edited,
 * deleted, or replaced with your own.
 *
 * One rule governs which hosts belong here: only what is SHARED across
 * organisations, because that is the only place cookies actually collide. Hosts
 * whose name carries the organisation (contoso.sharepoint.com,
 * acme.atlassian.net, acme.awsapps.com) are deliberately left out - they do not
 * collide, so freezing those tabs would cost you for nothing. That is why two
 * Jira instances from different companies work in parallel, while two Atlassian
 * sign-in screens do not.
 */
export const BUILTIN_REALMS: Realm[] = [
  {
    id: "microsoft",
    name: "Microsoft 365 / Entra ID",
    hosts: [
      "login.microsoftonline.com",
      "login.microsoft.com",
      "login.windows.net",
      "login.live.com",
      "account.microsoft.com",
      "admin.microsoft.com",
      "portal.azure.com",
      "portal.office.com",
      "outlook.office.com",
      "outlook.office365.com",
      "teams.microsoft.com",
      "security.microsoft.com",
      "compliance.microsoft.com",
      "endpoint.microsoft.com",
      "intune.microsoft.com",
    ],
    builtin: true,
  },
  {
    id: "google",
    name: "Google",
    hosts: ["accounts.google.com", "mail.google.com", "drive.google.com", "admin.google.com"],
    builtin: true,
  },
  {
    // No "*.atlassian.net" - the instance name there carries the organisation.
    id: "atlassian",
    name: "Atlassian (Jira, Confluence)",
    hosts: [
      "id.atlassian.com",
      "auth.atlassian.com",
      "api.atlassian.com",
      "start.atlassian.com",
      "admin.atlassian.com",
      "team.atlassian.com",
    ],
    builtin: true,
  },
  {
    // No "*.awsapps.com" - that subdomain carries the organisation.
    id: "aws",
    name: "Amazon Web Services",
    hosts: [
      "signin.aws.amazon.com",
      "console.aws.amazon.com",
      "*.console.aws.amazon.com",
      "portal.aws.amazon.com",
    ],
    builtin: true,
  },
  {
    id: "github",
    name: "GitHub",
    hosts: ["github.com", "*.github.com"],
    builtin: true,
  },
];

/** Tab group colours as hex, for badges and dots in the UI. */
export const COLOR_HEX: Record<GroupColor, string> = {
  grey: "#5f6368",
  blue: "#1a73e8",
  red: "#d93025",
  yellow: "#f9ab00",
  green: "#1e8e3e",
  pink: "#d01884",
  purple: "#9334e6",
  cyan: "#007b83",
  orange: "#fa903e",
};
