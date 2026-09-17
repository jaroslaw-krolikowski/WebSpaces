import { send } from "../shared/messages";
import type { Overview, Snapshot } from "../shared/messages";
import {
  ALWAYS_VISIBLE,
  BUILTIN_REALMS,
  COLOR_HEX,
  DEFAULT_CONTAINER_ID,
  GROUP_COLORS,
} from "../shared/types";
import type {
  BookmarkEntry,
  Container,
  GroupColor,
  OrphanBookmarks,
  Realm,
  Rule,
  State,
} from "../shared/types";
import { el, esc } from "./dom";
import { applyI18n, t } from "./i18n";

let state: State;

/**
 * Inline outline glyphs. They live here rather than in a font or an icon package
 * because the extension ships no runtime dependency, and an SVG that inherits
 * `currentColor` costs nothing and themes itself.
 */
const ICONS = {
  box: svg(
    '<path d="M21 8v8a2 2 0 0 1-1 1.73l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.73l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8z"/><polyline points="3.3 7 12 12 20.7 7"/><line x1="12" y1="22" x2="12" y2="12"/>',
  ),
  home: svg(
    '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  ),
  link: svg(
    '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  ),
  layers: svg(
    '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  ),
  trash: svg(
    '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
  ),
};

function svg(body: string): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

/**
 * Every interface action goes through this wrapper. Errors coming from the
 * background used to vanish without a trace - the button simply did nothing.
 */
function run(action: () => Promise<void>): void {
  void action().catch((error: unknown) => {
    status(error instanceof Error ? error.message : String(error), true);
  });
}

function status(message: string, isError = false): void {
  const node = el("status");
  node.textContent = message;
  node.hidden = false;
  node.style.borderColor = isError ? "var(--danger)" : "";
}

function clearStatus(): void {
  el("status").hidden = true;
}

let bookmarks: BookmarkEntry[] = [];
/** How many entries sit on the bar, as the extension sees it. */
let barCount = 0;
/** Whose bookmarks the bar is showing at this moment. */
let mountedOwner = DEFAULT_CONTAINER_ID;
/** Which owner the bookmark list is showing, kept across reloads. */
let shownOwner = DEFAULT_CONTAINER_ID;

async function load(): Promise<void> {
  const overview = await send<Overview>({ type: "getOverview" });
  state = overview.state;
  bookmarks = [];
  barCount = 0;
  mountedOwner = DEFAULT_CONTAINER_ID;
  if (state.settings.bookmarksPerContainer) {
    const listed = await send<{ entries: BookmarkEntry[]; onBar: number; mounted: string }>({
      type: "listBookmarks",
    });
    bookmarks = listed.entries;
    barCount = listed.onBar;
    mountedOwner = listed.mounted;
  }
  renderContainers();
  renderRules();
  renderRealms();
  renderSettings();
  renderSync();
  renderExperimental();
}

/* --- Experimental --- */

function renderExperimental(): void {
  el<HTMLInputElement>("bookmarks-per-container").checked = state.settings.bookmarksPerContainer;
  el<HTMLSelectElement>("orphan-bookmarks").value = state.settings.orphanBookmarks;
  el<HTMLButtonElement>("restore-bookmarks").disabled = !state.settings.bookmarksPerContainer;

  el("bookmark-manager").hidden = !state.settings.bookmarksPerContainer;
  if (!state.settings.bookmarksPerContainer) return;

  const counts: Record<string, number> = {};
  for (const entry of bookmarks) counts[entry.owner] = (counts[entry.owner] ?? 0) + 1;

  // A container the user deleted meanwhile would leave the list showing nothing
  // with no way back, so the selection falls home instead.
  const owners = [...state.containers.map((c) => c.id), ALWAYS_VISIBLE];
  if (!owners.includes(shownOwner)) shownOwner = DEFAULT_CONTAINER_ID;

  el("bookmark-owner").innerHTML = ownerOptions(shownOwner, counts);
  paintDot(el("bookmark-owner-dot"), shownOwner);
  renderBookmarkList(counts[shownOwner] ?? 0);

  // Saying what the extension actually sees, and whose bar it is. An entry
  // handed to the container already showing stays put, which reads as a broken
  // control unless the page says which container that is.
  const showing = state.containers.find((c) => c.id === mountedOwner)?.name ?? mountedOwner;
  el("bookmark-bar-state").textContent =
    barCount === 0
      ? t("barStateNone")
      : barCount === 1
        ? t("barStateOne", showing)
        : t("barStateMany", showing, String(barCount));
}

/** Colour names come from the Chrome enum, which is lower case throughout. */
function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function ownerColor(owner: string): string | null {
  if (owner === ALWAYS_VISIBLE) return null;
  return COLOR_HEX[state.containers.find((c) => c.id === owner)?.color ?? "grey"];
}

/**
 * The dot that sits beside a container picker. A `select` cannot hold a coloured
 * element, and colouring the option text itself would drop grey and yellow well
 * under the contrast floor, so the colour goes next to the control instead.
 */
function ownerDot(owner: string): string {
  const color = ownerColor(owner);
  return color === null
    ? '<span class="dot ring"></span>'
    : `<span class="dot" style="background:${color}"></span>`;
}

/** The same dot, for an element that lives in the markup rather than a template. */
function paintDot(node: HTMLElement, owner: string): void {
  const color = ownerColor(owner);
  node.className = color === null ? "dot ring" : "dot";
  node.style.background = color ?? "";
}

/** The owner picker and every per-row destination share one list of options. */
function ownerOptions(selected: string, counts?: Record<string, number>): string {
  const label = (id: string, name: string): string => {
    // A container with nothing in it still says so, rather than looking like a
    // row whose count failed to load.
    const suffix = counts ? ` (${counts[id] ?? 0})` : "";
    return `<option value="${esc(id)}" ${id === selected ? "selected" : ""}>${esc(
      name,
    )}${suffix}</option>`;
  };

  return (
    state.containers.map((c) => label(c.id, c.name)).join("") +
    label(ALWAYS_VISIBLE, t("pinnedEverywhere"))
  );
}

function renderBookmarkList(owned: number): void {
  if (owned === 0) {
    const empty = shownOwner === ALWAYS_VISIBLE ? t("emptyPinned") : t("emptyContainer");
    el("bookmark-list").innerHTML = `<p class="sub">${esc(empty)}</p>`;
    return;
  }

  el("bookmark-list").innerHTML = bookmarks
    .filter((entry) => entry.owner === shownOwner)
    .map((entry) => {
      // A folder carries everything inside it, so it is worth saying which is which.
      const kind = entry.url ?? t("bookmarkFolder");
      return `<div class="row" data-bookmark="${esc(entry.id)}">
        <span class="grow truncate" title="${esc(kind)}">${esc(entry.title)}</span>
        ${ownerDot(entry.owner)}
        <select data-field="owner" style="width:auto">${ownerOptions(entry.owner)}</select>
      </div>`;
    })
    .join("");
}

el("bookmark-owner").addEventListener("change", () => {
  shownOwner = el<HTMLSelectElement>("bookmark-owner").value;
  renderExperimental();
});

el("bookmark-list").addEventListener("change", (event) => {
  const select = event.target as HTMLSelectElement;
  const id = select.closest<HTMLElement>("[data-bookmark]")?.dataset["bookmark"];
  if (!id) return;

  run(async () => {
    clearStatus();
    await send({ type: "assignBookmark", bookmarkId: id, owner: select.value });
    await load();
  });
});

for (const id of ["bookmarks-per-container", "orphan-bookmarks"]) {
  el(id).addEventListener("change", () => {
    run(async () => {
      clearStatus();
      const enabling =
        el<HTMLInputElement>("bookmarks-per-container").checked &&
        !state.settings.bookmarksPerContainer;

      await send({
        type: "saveSettings",
        settings: {
          ...state.settings,
          bookmarksPerContainer: el<HTMLInputElement>("bookmarks-per-container").checked,
          orphanBookmarks: el<HTMLSelectElement>("orphan-bookmarks").value as OrphanBookmarks,
        },
      });
      await load();

      if (enabling) status(t("msgBookmarksOn"));
    });
  });
}

el("restore-bookmarks").addEventListener("click", () => {
  if (!confirm(t("confirmRestoreBookmarks"))) return;
  run(async () => {
    const result = await send<{ moved?: number }>({ type: "restoreBookmarks" });
    await load();
    status(t("msgBookmarksRestored", String(result.moved ?? 0)));
  });
});

/* --- Configuration sync --- */

function renderSync(): void {
  el<HTMLInputElement>("sync-enabled").checked = state.settings.syncEnabled;

  const node = el("sync-state");
  node.style.color = "";
  if (state.sync.lastError) {
    node.textContent = state.sync.lastError;
    node.style.color = "var(--danger)";
    return;
  }
  if (!state.settings.syncEnabled) {
    node.textContent = t("syncOff");
    return;
  }
  node.textContent = state.sync.lastAt
    ? t("syncLast", new Date(state.sync.lastAt).toLocaleString())
    : t("syncWaiting");
}

el("sync-enabled").addEventListener("change", () => {
  run(async () => {
    await send({
      type: "saveSettings",
      settings: { ...state.settings, syncEnabled: el<HTMLInputElement>("sync-enabled").checked },
    });
    await load();
  });
});

el("sync-clear").addEventListener("click", () => {
  if (!confirm(t("confirmClearSync"))) return;
  run(async () => {
    await send({ type: "clearSync" });
    await load();
    status(t("msgSharedCleared"));
  });
});

/* --- Sidebar navigation --- */

const SECTIONS = [
  "containers",
  "rules",
  "realms",
  "other",
  "backup",
  "experimental",
  "author",
];

applyI18n();

// The version comes from the manifest so the footer cannot drift from the build.
el("version").textContent = `WebSpaces ${chrome.runtime.getManifest().version}`;

function showSection(name: string): void {
  const target = SECTIONS.includes(name) ? name : "containers";
  for (const panel of document.querySelectorAll<HTMLElement>("[data-panel]")) {
    panel.hidden = panel.dataset["panel"] !== target;
  }
  for (const item of document.querySelectorAll<HTMLElement>(".nav-item")) {
    item.setAttribute("aria-current", String(item.dataset["section"] === target));
  }
}

for (const item of document.querySelectorAll<HTMLElement>(".nav-item")) {
  item.addEventListener("click", () => {
    // Driving the hash rather than the DOM gives back, forward and reload for free.
    location.hash = item.dataset["section"] ?? "";
  });
}

window.addEventListener("hashchange", () => showSection(location.hash.slice(1)));
showSection(location.hash.slice(1));

/* --- Containers --- */

function renderContainers(): void {
  const html = state.containers.map((container) => {
    const locked = container.id === DEFAULT_CONTAINER_ID;
    const colors = GROUP_COLORS.map(
      (color) =>
        `<option value="${color}" ${color === container.color ? "selected" : ""}>${capitalise(
          color,
        )}</option>`,
    ).join("");
    const hex = COLOR_HEX[container.color];
    const rules = state.rules.filter((rule) => rule.containerId === container.id).length;

    return `<div class="card" data-container="${esc(container.id)}">
      <div class="row">
        <span class="icon-tile" style="background:${hex}22;color:${hex}">
          ${locked ? ICONS.home : ICONS.box}
        </span>
        <div class="grow">
          <div class="row">
            <input type="text" class="ghost title grow" data-field="name"
                   value="${esc(container.name)}" ${locked ? "disabled" : ""} />
            ${locked ? `<span class="badge">${t("badgeSystem")}</span>` : ""}
          </div>
          <input type="text" class="ghost grow sub" data-field="description"
                 placeholder="${esc(t("phDescription"))}"
                 value="${esc(
                   container.description ?? (locked ? t("defaultContainerDesc") : ""),
                 )}" />
        </div>
        <span class="pill ${container.isolate ? "on" : ""}">
          ${t(container.isolate ? "pillIsolationOn" : "pillIsolationOff")}
        </span>
        <span class="sub">${
          rules === 1 ? t("ruleCountOne") : t("ruleCountMany", String(rules))
        }</span>
        <select data-field="color" style="width:auto" ${locked ? "disabled" : ""}>${colors}</select>
        ${
          locked
            ? ""
            : `<button class="icon-btn" data-field="delete" title="${esc(
                t("deleteContainerTitle"),
              )}" aria-label="${esc(t("deleteContainerTitle"))}">${ICONS.trash}</button>`
        }
      </div>
      <label class="check" style="margin:10px 0 0">
        <input type="checkbox" data-field="isolate" ${container.isolate ? "checked" : ""}
               ${locked ? "disabled" : ""} />
        <span>${t("keepVault")}
          <span class="sub">${t("keepVaultNote")}</span>
        </span>
      </label>
    </div>`;
  });

  el("containers").innerHTML = html.join("");
  renderStats();
  refreshRuleContainerPicker();
}

function renderStats(): void {
  const custom = state.containers.length - 1;
  const hosts = state.realms.reduce((total, realm) => total + realm.hosts.length, 0);
  const enabled = state.rules.filter((rule) => rule.enabled).length;

  el("stats").innerHTML = [
    stat(
      ICONS.box,
      state.containers.length,
      t("statContainers"),
      t("statContainersNote", String(custom)),
    ),
    stat(ICONS.link, state.rules.length, t("statRules"), t("statRulesNote", String(enabled))),
    stat(ICONS.layers, state.realms.length, t("statRealms"), t("statRealmsNote", String(hosts))),
  ].join("");
}

function stat(icon: string, value: number, label: string, note: string): string {
  return `<div class="stat">
    <span class="icon-tile plain">${icon}</span>
    <div>
      <div class="stat-num">${value}</div>
      <div class="stat-label">${esc(label)}</div>
      <div class="sub">${esc(note)}</div>
    </div>
  </div>`;
}

el("containers").addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement | HTMLSelectElement;
  const card = input.closest<HTMLElement>("[data-container]");
  const id = card?.dataset["container"];
  const container = state.containers.find((c) => c.id === id);
  if (!container) return;

  const next: Container = { ...container };
  const field = input.dataset["field"];
  if (field === "name") next.name = (input as HTMLInputElement).value.trim() || container.name;
  if (field === "description") next.description = (input as HTMLInputElement).value.trim();
  if (field === "color") next.color = input.value as GroupColor;
  if (field === "isolate") next.isolate = (input as HTMLInputElement).checked;

  run(async () => {
    await send({ type: "updateContainer", container: next });
    await load();
  });
});

el("containers").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-field="delete"]');
  const id = button?.closest<HTMLElement>("[data-container]")?.dataset["container"];
  if (!id) return;
  const container = state.containers.find((c) => c.id === id);
  if (!container) return;
  if (!confirm(t("confirmDeleteContainer", container.name))) return;
  run(async () => {
    await send({ type: "deleteContainer", containerId: id });
    await load();
  });
});

el("add-container").addEventListener("click", () => {
  const input = el<HTMLInputElement>("new-name");
  const describe = el<HTMLInputElement>("new-description");
  const name = input.value.trim();
  if (!name) {
    status(t("msgEnterContainerName"), true);
    return;
  }

  run(async () => {
    clearStatus();
    await send({
      type: "createContainer",
      name,
      color: "",
      description: describe.value.trim(),
    });
    input.value = "";
    describe.value = "";
    await load();
    // A container on its own does not create a tab group yet - the group appears
    // once the first tab joins it. Worth saying out loud.
    status(t("msgContainerAdded", name));
  });
});

/* --- Rules --- */

function renderRules(): void {
  if (state.rules.length === 0) {
    el("rules").innerHTML = `<p class="sub">${t("rulesEmpty")}</p>`;
    return;
  }

  el("rules").innerHTML = state.rules
    .map((rule) => {
      const options = state.containers
        .map(
          (c) =>
            `<option value="${esc(c.id)}" ${c.id === rule.containerId ? "selected" : ""}>${esc(
              c.name,
            )}</option>`,
        )
        .join("");
      return `<div class="row" data-rule="${esc(rule.id)}">
        <input type="checkbox" data-field="enabled" ${rule.enabled ? "checked" : ""} />
        <input type="text" class="grow" data-field="pattern" value="${esc(rule.pattern)}" />
        ${ownerDot(rule.containerId)}
        <select data-field="container" style="width:auto">${options}</select>
        <button class="icon-btn" data-field="delete" title="${esc(t("deleteRuleTitle"))}"
                aria-label="${esc(t("deleteRuleTitle"))}">${ICONS.trash}</button>
      </div>`;
    })
    .join("");
}

function refreshRuleContainerPicker(): void {
  el("new-rule-container").innerHTML = state.containers
    .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`)
    .join("");
}

el("rules").addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement | HTMLSelectElement;
  const id = input.closest<HTMLElement>("[data-rule]")?.dataset["rule"];
  if (!id) return;

  const rules = state.rules.map((rule) => {
    if (rule.id !== id) return rule;
    const next: Rule = { ...rule };
    const field = input.dataset["field"];
    if (field === "enabled") next.enabled = (input as HTMLInputElement).checked;
    if (field === "pattern") next.pattern = (input as HTMLInputElement).value.trim();
    if (field === "container") next.containerId = input.value;
    return next;
  });

  run(async () => {
    await send({ type: "saveRules", rules });
    await load();
  });
});

el("rules").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-field="delete"]');
  const id = button?.closest<HTMLElement>("[data-rule]")?.dataset["rule"];
  if (!id) return;
  run(async () => {
    await send({ type: "saveRules", rules: state.rules.filter((r) => r.id !== id) });
    await load();
  });
});

el("add-rule").addEventListener("click", () => {
  const patternInput = el<HTMLInputElement>("new-pattern");
  const pattern = patternInput.value.trim();
  const containerId = el<HTMLSelectElement>("new-rule-container").value;
  if (!pattern || !containerId) return;

  const rule: Rule = {
    id: crypto.randomUUID().slice(0, 8),
    pattern,
    containerId,
    enabled: true,
  };
  run(async () => {
    clearStatus();
    const result = await send<{ moved?: number }>({
      type: "saveRules",
      rules: [...state.rules, rule],
    });
    patternInput.value = "";
    await load();

    const moved = result.moved ?? 0;
    status(
      moved === 0
        ? t("msgRuleAdded")
        : moved === 1
          ? t("msgRuleAddedMovedOne")
          : t("msgRuleAddedMoved", String(moved)),
    );
  });
});

/* --- Realms --- */

function renderRealms(): void {
  el("realms").innerHTML =
    state.realms.length === 0
      ? `<p class="sub">${t("realmsEmpty")}</p>`
      : state.realms
          .map(
            (realm) => `<div class="card" data-realm="${esc(realm.id)}">
        <div class="row">
          <span class="icon-tile plain">${ICONS.layers}</span>
          <input type="text" class="ghost title grow" data-field="name"
                 value="${esc(realm.name)}" />
          <span class="sub">${t("hostsCount", String(realm.hosts.length))}</span>
          <button class="icon-btn" data-field="delete" title="${esc(t("deleteRealmTitle"))}"
                  aria-label="${esc(t("deleteRealmTitle"))}">${ICONS.trash}</button>
        </div>
        <textarea data-field="hosts" style="margin-top:8px">${esc(realm.hosts.join("\n"))}</textarea>
      </div>`,
          )
          .join("");
  refreshPresetPicker();
}

/** Only presets that are not present yet stay in the list. */
function refreshPresetPicker(): void {
  const present = new Set(state.realms.map((r) => r.id));
  const available = BUILTIN_REALMS.filter((preset) => !present.has(preset.id));
  const picker = el<HTMLSelectElement>("preset-realm");
  picker.innerHTML = available
    .map((preset) => `<option value="${esc(preset.id)}">${esc(preset.name)}</option>`)
    .join("");
  picker.disabled = available.length === 0;
  el<HTMLButtonElement>("add-preset").disabled = available.length === 0;
  if (available.length === 0) {
    picker.innerHTML = `<option>${t("presetsAllAdded")}</option>`;
  }
}

el("realms").addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement | HTMLTextAreaElement;
  const id = input.closest<HTMLElement>("[data-realm]")?.dataset["realm"];
  if (!id) return;

  const field = input.dataset["field"];
  const realms: Realm[] = state.realms.map((realm) => {
    if (realm.id !== id) return realm;
    if (field === "name") return { ...realm, name: input.value.trim() || realm.name };
    return {
      ...realm,
      hosts: input.value
        .split("\n")
        .map((line) => line.trim().toLowerCase())
        .filter(Boolean),
    };
  });

  run(async () => {
    await send({ type: "saveRealms", realms });
    await load();
  });
});

el("realms").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-field="delete"]');
  const id = button?.closest<HTMLElement>("[data-realm]")?.dataset["realm"];
  if (!id) return;
  const realm = state.realms.find((r) => r.id === id);
  if (!realm) return;
  if (!confirm(t("confirmDeleteRealm", realm.name))) return;
  run(async () => {
    await send({ type: "deleteRealm", realmId: id });
    await load();
    status(t("msgRealmDeleted", realm.name));
  });
});

el("add-realm").addEventListener("click", () => {
  const input = el<HTMLInputElement>("new-realm");
  const name = input.value.trim();
  if (!name) {
    status(t("msgEnterRealmName"), true);
    return;
  }
  run(async () => {
    clearStatus();
    await send({ type: "createRealm", name, hosts: [] });
    input.value = "";
    await load();
    status(t("msgRealmAdded", name));
  });
});

el("add-preset").addEventListener("click", () => {
  const preset = BUILTIN_REALMS.find((r) => r.id === el<HTMLSelectElement>("preset-realm").value);
  if (!preset) return;
  run(async () => {
    clearStatus();
    // A preset returns under its own id, so adding it again restores exactly the
    // same realm rather than a copy under a new id.
    await send({ type: "saveRealms", realms: [...state.realms, preset] });
    await load();
    status(t("msgPresetAdded", preset.name));
  });
});

/* --- Behaviour --- */

function renderSettings(): void {
  el<HTMLInputElement>("auto-mount").checked = state.settings.autoMountOnFocus;
  el<HTMLInputElement>("show-interstitial").checked = state.settings.showInterstitial;
  el<HTMLInputElement>("clear-site-data").checked = state.settings.clearSiteDataOnSwitch;
}

for (const id of ["auto-mount", "show-interstitial", "clear-site-data"]) {
  el(id).addEventListener("change", () => {
    run(async () => {
      await send({
        type: "saveSettings",
        settings: {
          ...state.settings,
          autoMountOnFocus: el<HTMLInputElement>("auto-mount").checked,
          showInterstitial: el<HTMLInputElement>("show-interstitial").checked,
          clearSiteDataOnSwitch: el<HTMLInputElement>("clear-site-data").checked,
        },
      });
      await load();
    });
  });
}

/* --- File export and import --- */

el("export").addEventListener("click", () => {
  const includeCookies = el<HTMLInputElement>("include-cookies").checked;
  if (includeCookies && !confirm(t("confirmExportCookies"))) return;

  run(async () => {
    const snapshot = await send<Snapshot>({ type: "exportSnapshot", includeCookies });
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `webspaces-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    status(
      t("msgExported", String(snapshot.windows.length), String(snapshot.containers.length)),
    );
  });
});

el("import").addEventListener("click", () => el("file").click());

el("file").addEventListener("change", () => {
  const input = el<HTMLInputElement>("file");
  const file = input.files?.[0];
  if (!file) return;

  run(async () => {
    try {
      const snapshot = JSON.parse(await file.text()) as Snapshot;
      await send({
        type: "importSnapshot",
        snapshot,
        restoreWindows: el<HTMLInputElement>("restore-windows").checked,
      });
      await load();
      status(t("msgLoaded"));
    } finally {
      input.value = "";
    }
  });
});

run(load);
