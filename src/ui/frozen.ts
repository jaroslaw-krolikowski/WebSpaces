import { send } from "../shared/messages";
import type { PendingInfo } from "../shared/messages";
import { carriedUrl } from "../shared/realms";
import { COLOR_HEX } from "../shared/types";
import { el, esc } from "./dom";

const app = el("app");

async function start(): Promise<void> {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id === undefined) {
    app.innerHTML = '<div class="card">Could not identify this tab.</div>';
    return;
  }
  const tabId = tab.id;
  const carried = carriedUrl(location.href);
  const info = await send<PendingInfo>({
    type: "getPending",
    tabId,
    ...(carried ? { url: carried } : {}),
  });

  // A rule already picked the container, so there is nothing to ask about.
  if (info.autoResolve && info.suggestedContainerId) {
    await resolve(tabId, info.suggestedContainerId, carried);
    return;
  }

  render(tabId, info, carried);
}

async function resolve(tabId: number, containerId: string, url: string | null): Promise<void> {
  const result = await send<{ navigated?: boolean }>({
    type: "resolveFrozen",
    tabId,
    containerId,
    ...(url ? { url } : {}),
  });
  if (!result?.navigated) {
    throw new Error(
      "The tab was assigned to the container, but the address it was heading to could " +
        "not be determined. Type it again in the address bar - it will go through without asking.",
    );
  }
}

function render(tabId: number, info: PendingInfo, carried: string | null): void {
  const byId = new Map(info.containers.map((c) => [c.id, c]));
  const mounted = info.mountedContainerId ? byId.get(info.mountedContainerId) : undefined;
  const html: string[] = [];

  html.push("<h1>Which container should open this?</h1>");
  html.push(
    `<p class="sub">${
      info.realmName
        ? `This address belongs to the <strong>${esc(info.realmName)}</strong> realm, where ` +
          "container sessions are mutually exclusive."
        : "This address needs a container."
    }</p>`,
  );

  if (info.url) html.push(`<p class="mono">${esc(info.url)}</p>`);

  if (mounted) {
    html.push(
      `<div class="warn">The browser jar currently holds the session of
       <strong>${esc(mounted.name)}</strong>. Choosing another container parks that session
       and freezes its open tabs until you come back.</div>`,
    );
  }

  html.push('<div class="list">');
  for (const container of info.containers) {
    html.push(
      `<button class="pick" data-container="${esc(container.id)}">
         <span class="dot" style="background:${COLOR_HEX[container.color]}"></span>
         <span class="grow truncate">${esc(container.name)}</span>
         ${container.id === info.currentContainerId ? '<span class="sub">tab is here</span>' : ""}
       </button>`,
    );
  }
  html.push("</div>");

  app.innerHTML = html.join("");

  app.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-container]");
    const containerId = button?.dataset["container"];
    if (!containerId) return;
    resolve(tabId, containerId, carried ?? info.url).catch(fail);
  });
}

function fail(error: unknown): void {
  app.innerHTML = `<div class="card">${esc(
    error instanceof Error ? error.message : String(error),
  )}</div>`;
}

start().catch(fail);
