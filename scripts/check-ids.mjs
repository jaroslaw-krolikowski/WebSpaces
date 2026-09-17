// Every id that el() asks for must exist in the matching page. el() throws on a
// missing element, and in a module that throw kills the rest of the script, so a
// single stale id takes down the whole settings page rather than one control.
// That failure looks exactly like "the extension does nothing", which is the one
// failure mode this project refuses to ship.
import { readFileSync } from "node:fs";

const PAGES = [
  ["src/ui/options.ts", "src/ui/options.html"],
  ["src/ui/popup.ts", "src/ui/popup.html"],
  ["src/ui/frozen.ts", "src/ui/frozen.html"],
];

// el("name") and el<HTMLInputElement>("name"), single or double quoted.
const CALL = /\bel\s*(?:<[^>]*>)?\s*\(\s*["']([^"']+)["']\s*\)/g;
const ID = /\bid\s*=\s*["']([^"']+)["']/g;

let failed = false;

for (const [script, page] of PAGES) {
  const source = readFileSync(script, "utf8");
  const markup = readFileSync(page, "utf8");

  const present = new Set([...markup.matchAll(ID)].map((match) => match[1]));
  const wanted = new Set([...source.matchAll(CALL)].map((match) => match[1]));
  const missing = [...wanted].filter((id) => !present.has(id));

  if (missing.length > 0) {
    failed = true;
    console.error(`${script} asks for ids that ${page} does not have:`);
    for (const id of missing) console.error(`  #${id}`);
  } else {
    console.log(`${script}: ${wanted.size} ids, all present in ${page}`);
  }
}

// A class nobody styles is the quiet half of the same problem: the markup looks
// right in the source and renders as unstyled boxes. Nothing throws, so only
// looking at the page would catch it.
const css = readFileSync("src/ui/ui.css", "utf8");
const defined = new Set([...css.matchAll(/\.([a-z][a-z0-9-]*)/gi)].map((match) => match[1]));
const used = new Set();

for (const file of [...PAGES.flat()]) {
  const source = readFileSync(file, "utf8");
  // Template literals interpolate, so a class list holding ${...} is skipped
  // rather than guessed at.
  for (const match of source.matchAll(/class=["'`]([^"'`$]+)["'`]/g)) {
    for (const name of match[1].split(/\s+/).filter(Boolean)) used.add(name);
  }
}

const unstyled = [...used].filter((name) => !defined.has(name)).sort();
if (unstyled.length > 0) {
  failed = true;
  console.error("classes used in the markup that ui.css does not define:");
  for (const name of unstyled) console.error(`  .${name}`);
} else {
  console.log(`ui.css: ${used.size} classes used, all defined`);
}

// A message key nobody defined renders as the key itself, which is visible but
// only in the language nobody is testing. Cheaper to catch here.
const messages = JSON.parse(readFileSync("_locales/en/messages.json", "utf8"));
const known = new Set(Object.keys(messages));
const asked = new Set();

for (const file of [...PAGES.flat(), "src/background/index.ts"]) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/\bt\(\s*"([^"]+)"/g)) asked.add(match[1]);
  for (const match of source.matchAll(/getMessage\(\s*"([^"]+)"/g)) asked.add(match[1]);
  for (const match of source.matchAll(/data-i18n(?:-html|-ph|-title|-doc)?="([^"]+)"/g)) {
    asked.add(match[1]);
  }
}

const undefinedKeys = [...asked].filter((key) => !known.has(key)).sort();
if (undefinedKeys.length > 0) {
  failed = true;
  console.error("message keys used but missing from _locales/en/messages.json:");
  for (const key of undefinedKeys) console.error(`  ${key}`);
} else {
  console.log(`_locales: ${asked.size} keys used, all defined in en`);
}

// Every other locale may be sparse - Chrome falls back to the default - but a
// key that exists nowhere is a bug, and one that exists only in a translation is
// dead weight.
for (const locale of ["pl"]) {
  const other = JSON.parse(readFileSync(`_locales/${locale}/messages.json`, "utf8"));
  const gaps = [...known].filter((key) => !(key in other));
  const strays = Object.keys(other).filter((key) => !known.has(key));
  if (gaps.length > 0) console.warn(`_locales/${locale}: ${gaps.length} keys fall back to en`);
  if (strays.length > 0) {
    failed = true;
    console.error(`_locales/${locale} defines keys that en does not: ${strays.join(", ")}`);
  }
  if (gaps.length === 0 && strays.length === 0) {
    console.log(`_locales/${locale}: complete, ${Object.keys(other).length} keys`);
  }
}

// Ids built at runtime are out of reach here, so this checks the literal calls
// only. It has still caught every breakage so far.
if (failed) process.exit(1);
