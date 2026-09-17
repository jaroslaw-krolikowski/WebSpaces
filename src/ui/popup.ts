import { send } from "../shared/messages";
import type { Overview } from "../shared/messages";
import { COLOR_HEX, DEFAULT_CONTAINER_ID } from "../shared/types";
import { el, esc } from "./dom";
import { applyI18n, t } from "./i18n";

const app = el("app");

el("open-options").addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

/**
 * The host of the active tab, as a realm would list it. A leading `www.` is
 * dropped because nobody thinks of it as part of the site, and a realm listing
 * `www.example.com` would miss every other page of the same site.
 */
function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== "https:" && protocol !== "http:") return null;
    return hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

async function render(): Promise<void> {
  const { state, activeTab, frozenCounts } = await send<Overview>({ type: "getOverview" });
  const [openTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const host = hostOf(openTab?.url);
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
       <strong class="truncate">${esc(current?.name ?? t("defaultContainerName"))}</strong>
     </span>`,
  );
  if (activeTab?.frozen) html.push(`<span class="frozen-badge">${t("popupFrozen")}</span>`);
  html.push("</div>");

  if (realm) {
    const mounted = byId.get(state.mounted[realm.id] ?? DEFAULT_CONTAINER_ID);
    html.push(
      `<div class="sub" style="margin-top:6px">${esc(
        t("popupInJar", realm.name, mounted?.name ?? t("defaultContainerName")),
      )}</div>`,
    );
    if (activeTab?.frozen && current) {
      html.push(
        `<div class="row" style="margin-top:10px">
           <button class="primary grow" data-action="mount"
                   data-realm="${esc(realm.id)}" data-container="${esc(current.id)}">
             ${t("popupSwitch")}
           </button>
         </div>`,
      );
    }
  } else {
    html.push(`<div class="sub" style="margin-top:6px">${t("popupNoRealm")}</div>`);
    // The realm list is the whole mechanism, so the fastest way to extend it is
    // from the site you are looking at, not from a text field in settings.
    if (host) {
      html.push(
        `<div class="row" style="margin-top:10px">
           <button class="grow" data-action="isolate" data-host="${esc(host)}">
             ${esc(t("popupIsolateSite", host))}
           </button>
         </div>
         <div class="sub" style="margin-top:6px">${t("popupIsolateNote")}</div>`,
      );
    }
  }
  html.push("</div>");

  /* Tab assignment */
  if (activeTab) {
    html.push(`<h2>${t("popupMoveTab")}</h2>`);
    html.push('<div class="list">');
    for (const container of state.containers) {
      const active = container.id === activeTab.containerId;
      html.push(
        `<button class="pick" data-action="assign" data-container="${esc(container.id)}"
                 ${active ? "disabled" : ""}>
           <span class="dot" style="background:${COLOR_HEX[container.color]}"></span>
           <span class="grow truncate">${esc(container.name)}</span>
           ${active ? `<span class="sub">${t("popupCurrent")}</span>` : ""}
         </button>`,
      );
    }
    html.push("</div>");
  }

  /* Realm summary */
  html.push(`<h2>${t("popupRealms")}</h2>`);
  html.push('<div class="list">');
  for (const item of state.realms) {
    const mounted = byId.get(state.mounted[item.id] ?? DEFAULT_CONTAINER_ID);
    const frozen = frozenCounts[item.id] ?? 0;
    html.push(
      `<div class="row spread">
         <span class="grow truncate">${esc(item.name)}</span>
         <span class="sub">${esc(mounted?.name ?? t("defaultContainerName"))}${
           frozen > 0 ? esc(t("popupFrozenCount", String(frozen))) : ""
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
  if (button.dataset["action"] === "isolate") {
    const host = button.dataset["host"];
    if (!host) return;
    // One realm per site keeps the freezing as narrow as it can be: only tabs on
    // this host, in other containers, and nothing else in the browser.
    // The wildcard covers subdomains; the bare host is what browsingData can clear.
    await send({ type: "createRealm", name: host, hosts: [host, `*.${host}`] });
    await render();
    return;
  }

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

applyI18n();
render().catch(fail);
