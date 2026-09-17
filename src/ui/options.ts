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

let state: State;

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
/** Which owner the bookmark list is showing, kept across reloads. */
let shownOwner = DEFAULT_CONTAINER_ID;

async function load(): Promise<void> {
  const overview = await send<Overview>({ type: "getOverview" });
  state = overview.state;
  bookmarks = state.settings.bookmarksPerContainer
    ? (await send<{ entries: BookmarkEntry[] }>({ type: "listBookmarks" })).entries
    : [];
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
  renderBookmarkList(counts[shownOwner] ?? 0);
}

/** The owner picker and every per-row destination share one list of options. */
function ownerOptions(selected: string, counts?: Record<string, number>): string {
  const label = (id: string, name: string): string => {
    const owned = counts?.[id];
    const suffix = owned === undefined ? "" : ` (${owned})`;
    return `<option value="${esc(id)}" ${id === selected ? "selected" : ""}>${esc(
      name,
    )}${suffix}</option>`;
  };

  return (
    state.containers.map((c) => label(c.id, c.name)).join("") +
    label(ALWAYS_VISIBLE, "Pinned to every bar")
  );
}

function renderBookmarkList(owned: number): void {
  if (owned === 0) {
    el("bookmark-list").innerHTML =
      shownOwner === ALWAYS_VISIBLE
        ? '<p class="sub">Nothing is pinned. An entry set to this stays on the bar in every container.</p>'
        : '<p class="sub">Nothing here yet. Bookmarks you add while this container is showing land ' +
          "here. To bring one over, pick the container that has it above and change its owner.</p>";
    return;
  }

  el("bookmark-list").innerHTML = bookmarks
    .filter((entry) => entry.owner === shownOwner)
    .map((entry) => {
      // A folder carries everything inside it, so it is worth saying which is which.
      const kind = entry.url ?? "Folder";
      return `<div class="row" data-bookmark="${esc(entry.id)}">
        <span class="grow truncate" title="${esc(kind)}">${esc(entry.title)}</span>
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

      if (enabling) {
        status(
          "On. The bar you had is now the Default set. Switch to another container and the bar " +
            "empties for it, ready for whatever you bookmark there.",
        );
      }
    });
  });
}

el("restore-bookmarks").addEventListener("click", () => {
  if (
    !confirm(
      "Put every parked bookmark back on the bar?\n\n" +
        "Nothing is deleted. The bar ends up holding everything at once, which is where it was " +
        "before this feature was switched on.",
    )
  ) {
    return;
  }
  run(async () => {
    const result = await send<{ moved?: number }>({ type: "restoreBookmarks" });
    await load();
    status(`Moved ${result.moved ?? 0} back onto the bar.`);
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
    node.textContent = "Off. This device keeps its configuration to itself.";
    return;
  }
  node.textContent = state.sync.lastAt
    ? `Last exchange: ${new Date(state.sync.lastAt).toLocaleString()}`
    : "Waiting for the first exchange.";
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
  if (
    !confirm(
      "Clear the configuration shared through Chrome?\n\n" +
        "Only the shared copy goes away. This device keeps everything it has, and the next " +
        "change here will publish it again.",
    )
  ) {
    return;
  }
  run(async () => {
    await send({ type: "clearSync" });
    await load();
    status("Shared copy cleared.");
  });
});

/* --- Sidebar navigation --- */

const SECTIONS = ["containers", "rules", "realms", "other", "backup", "experimental"];

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
        `<option value="${color}" ${color === container.color ? "selected" : ""}>${color}</option>`,
    ).join("");

    return `<div class="card" data-container="${esc(container.id)}">
      <div class="row">
        <span class="dot" style="background:${COLOR_HEX[container.color]}"></span>
        <input type="text" class="grow" data-field="name" value="${esc(container.name)}"
               ${locked ? "disabled" : ""} />
        <select data-field="color" style="width:auto" ${locked ? "disabled" : ""}>${colors}</select>
        ${locked ? "" : '<button class="danger" data-field="delete">Delete</button>'}
      </div>
      <label class="check" style="margin:8px 0 0">
        <input type="checkbox" data-field="isolate" ${container.isolate ? "checked" : ""}
               ${locked ? "disabled" : ""} />
        <span>Keep its own cookie vault
          <span class="sub">- with this off the container is only a label on a tab group.</span>
        </span>
      </label>
    </div>`;
  });

  el("containers").innerHTML = html.join("");
  refreshRuleContainerPicker();
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
  if (!confirm(`Delete the container "${container.name}" and its saved cookies?`)) return;
  run(async () => {
    await send({ type: "deleteContainer", containerId: id });
    await load();
  });
});

el("add-container").addEventListener("click", () => {
  const input = el<HTMLInputElement>("new-name");
  const name = input.value.trim();
  if (!name) {
    status("Enter a container name.", true);
    return;
  }

  run(async () => {
    clearStatus();
    await send({ type: "createContainer", name, color: "" });
    input.value = "";
    await load();
    // A container on its own does not create a tab group yet - the group appears
    // once the first tab joins it. Worth saying out loud.
    status(
      `Container "${name}" added. Its tab group will appear once you move the first tab ` +
        "into it, from the popup or the right-click menu.",
    );
  });
});

/* --- Rules --- */

function renderRules(): void {
  if (state.rules.length === 0) {
    el("rules").innerHTML = '<p class="sub">No rules yet.</p>';
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
        <select data-field="container" style="width:auto">${options}</select>
        <button class="danger" data-field="delete">Delete</button>
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
      moved > 0
        ? `Rule added. Moved ${moved} open ${moved === 1 ? "tab" : "tabs"}.`
        : "Rule added. No open tab matches it yet, it will apply the next time you visit.",
    );
  });
});

/* --- Realms --- */

function renderRealms(): void {
  el("realms").innerHTML =
    state.realms.length === 0
      ? '<p class="sub">No realms. Nothing is swapped, so containers are just labels on ' +
        "tab groups.</p>"
      : state.realms
          .map(
            (realm) => `<div class="card" data-realm="${esc(realm.id)}">
        <div class="row">
          <input type="text" class="grow" data-field="name" value="${esc(realm.name)}" />
          <span class="sub">${realm.hosts.length} hosts</span>
          <button class="danger" data-field="delete">Delete</button>
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
    picker.innerHTML = "<option>Every preset has been added</option>";
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
  if (
    !confirm(
      `Delete the realm "${realm.name}"?\n\n` +
        "Sessions saved for it across all containers will be lost and those hosts will stop " +
        "being isolated. The currently mounted session is handed back to the default container.",
    )
  ) {
    return;
  }
  run(async () => {
    await send({ type: "deleteRealm", realmId: id });
    await load();
    status(`Realm "${realm.name}" deleted.`);
  });
});

el("add-realm").addEventListener("click", () => {
  const input = el<HTMLInputElement>("new-realm");
  const name = input.value.trim();
  if (!name) {
    status("Enter a realm name.", true);
    return;
  }
  run(async () => {
    clearStatus();
    await send({ type: "createRealm", name, hosts: [] });
    input.value = "";
    await load();
    status(`Realm "${name}" added. Now list the hosts that should be isolated.`);
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
    status(`Preset "${preset.name}" added.`);
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
  if (
    includeCookies &&
    !confirm(
      "The file will contain live sign-in sessions in plain text.\n" +
        "Anyone who opens it gets into those accounts without a password and without MFA." +
        "\n\nContinue?",
    )
  ) {
    return;
  }

  run(async () => {
    const snapshot = await send<Snapshot>({ type: "exportSnapshot", includeCookies });
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `webspaces-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    status(`Saved ${snapshot.windows.length} windows and ${snapshot.containers.length} containers.`);
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
      status("Loaded.");
    } finally {
      input.value = "";
    }
  });
});

run(load);
