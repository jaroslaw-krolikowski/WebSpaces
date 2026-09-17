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

// Ids built at runtime are out of reach here, so this checks the literal calls
// only. It has still caught every breakage so far.
if (failed) process.exit(1);
