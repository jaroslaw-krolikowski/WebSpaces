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

// Ids built at runtime are out of reach here, so this checks the literal calls
// only. It has still caught every breakage so far.
if (failed) process.exit(1);
