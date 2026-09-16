import { send } from "../shared/messages";
import type { Overview } from "../shared/messages";
import { COLOR_HEX, DEFAULT_CONTAINER_ID } from "../shared/types";
import { el, esc } from "./dom";

const app = el("app");

el("open-options").addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

async function render(): Promise<void> {
  const { state, activeTab, frozenCounts } = await send<Overview>({ type: "getOverview" });
  const byId = new Map(state.containers.map((c) => [c.id, c]));
  const current = activeTab ? byId.get(activeTab.containerId) : undefined;
  const realm = activeTab?.realmId
    ? (state.realms.find((r) => r.id === activeTab.realmId) ?? null)
    : null;

  const html: string[] = [];

  /* Current tab */
  html.push('<div class="card">');
  html.push('<div class="row spread">');
  html.push(
    `<span class="row grow truncate">
       <span class="dot" style="background:${COLOR_HEX[current?.color ?? "grey"]}"></span>
       <strong class="truncate">${esc(current?.name ?? "Default")}</strong>
     </span>`,
  );
  if (activeTab?.frozen) html.push('<span class="frozen-badge">frozen</span>');
  html.push("</div>");

  if (realm) {
    const mounted = byId.get(state.mounted[realm.id] ?? DEFAULT_CONTAINER_ID);
    html.push(
      `<div class="sub" style="margin-top:6px">${esc(realm.name)} · in the jar:
       ${esc(mounted?.name ?? "Default")}</div>`,
    );
    if (activeTab?.frozen && current) {
      html.push(
        `<div class="row" style="margin-top:10px">
           <button class="primary grow" data-action="mount"
                   data-realm="${esc(realm.id)}" data-container="${esc(current.id)}">
             Switch to this container and reload
           </button>
         </div>`,
      );
    }
  } else {
    html.push(
      '<div class="sub" style="margin-top:6px">This site belongs to no realm, so no ' +
        "cookies are swapped here.</div>",
    );
  }
  html.push("</div>");

  /* Tab assignment */
  if (activeTab) {
    html.push("<h2>Move this tab to</h2>");
    html.push('<div class="list">');
    for (const container of state.containers) {
      const active = container.id === activeTab.containerId;
      html.push(
        `<button class="pick" data-action="assign" data-container="${esc(container.id)}"
                 ${active ? "disabled" : ""}>
           <span class="dot" style="background:${COLOR_HEX[container.color]}"></span>
           <span class="grow truncate">${esc(container.name)}</span>
           ${active ? '<span class="sub">current</span>' : ""}
         </button>`,
      );
    }
    html.push("</div>");
  }

  /* Realm summary */
  html.push("<h2>Realms</h2>");
  html.push('<div class="list">');
  for (const item of state.realms) {
    const mounted = byId.get(state.mounted[item.id] ?? DEFAULT_CONTAINER_ID);
    const frozen = frozenCounts[item.id] ?? 0;
    html.push(
      `<div class="row spread">
         <span class="grow truncate">${esc(item.name)}</span>
         <span class="sub">${esc(mounted?.name ?? "Default")}${
           frozen > 0 ? ` · ${frozen} frozen` : ""
         }</span>
       </div>`,
    );
  }
  html.push("</div>");

  app.innerHTML = html.join("");
}

function fail(error: unknown): void {
  app.innerHTML = `<div class="card">${esc(
    error instanceof Error ? error.message : String(error),
  )}</div>`;
}

app.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!button) return;
  handleAction(button).catch(fail);
});

async function handleAction(button: HTMLElement): Promise<void> {
  const containerId = button.dataset["container"];
  if (!containerId) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (button.dataset["action"] === "mount") {
    const realmId = button.dataset["realm"];
    if (!realmId) return;
    await send({ type: "mount", realmId, containerId });
    if (tab?.id !== undefined) await chrome.tabs.reload(tab.id);
    window.close();
    return;
  }

  if (button.dataset["action"] === "assign" && tab?.id !== undefined) {
    await send({ type: "assignTab", tabId: tab.id, containerId });
    await render();
  }
}

render().catch(fail);
