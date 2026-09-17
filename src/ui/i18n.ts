/**
 * Translation for the extension pages.
 *
 * Chrome resolves the locale from the browser UI language and substitutes
 * `__MSG_*__` in the manifest on its own. A key missing from a translation falls
 * back to the default locale, so a partial translation still runs - which is why
 * `_locales/en` has to stay complete.
 *
 * There is deliberately no language picker: `chrome.i18n` is bound to the
 * browser language and cannot be switched at runtime. Adding one would mean
 * loading the message files by hand and keeping a second mechanism alive next to
 * the one Chrome already uses for the store listing.
 */
export function t(key: string, ...subs: string[]): string {
  // Falling back to the key makes a missing message obvious instead of leaving a
  // blank element that looks like a rendering bug.
  return chrome.i18n.getMessage(key, subs) || key;
}

/**
 * Fills in everything the markup marks as translatable, so the HTML files keep
 * their structure and only their text comes from the message files.
 *
 * `data-i18n-html` exists for the handful of sentences that carry inline markup
 * (`<span class="mono">`, `<strong>`). Those strings are ours, bundled with the
 * extension, never user input.
 */
export function applyI18n(root: ParentNode = document): void {
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    node.textContent = t(node.dataset["i18n"] ?? "");
  }
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n-html]")) {
    node.innerHTML = t(node.dataset["i18nHtml"] ?? "");
  }
  for (const node of root.querySelectorAll<HTMLInputElement>("[data-i18n-ph]")) {
    node.placeholder = t(node.dataset["i18nPh"] ?? "");
  }
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    node.title = t(node.dataset["i18nTitle"] ?? "");
  }

  // A separate attribute from data-i18n-title, which sets a tooltip: the page
  // title would otherwise also land on the html element as one.
  const title = document.documentElement.dataset["i18nDoc"];
  if (title) document.title = t(title);
  document.documentElement.lang = chrome.i18n.getUILanguage();
}
