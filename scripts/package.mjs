// Builds a distributable archive of the extension.
//
// A zip is the only format worth producing. Chrome refuses to install a signed
// .crx that did not come from the Web Store, failing with
// CRX_REQUIRED_PROOF_MISSING, so a crx would only disappoint whoever downloaded
// it. The same zip serves both audiences: the Web Store accepts it for upload,
// and anyone else unpacks it and uses Load unpacked.
//
// The manifest has to sit at the root of the archive, so the contents of dist
// are zipped rather than the directory itself.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import JSZip from "jszip";

const OUT_DIR = "release";
const BUILD_DIR = "dist";

const build = spawnSync(process.execPath, ["build.mjs"], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const manifest = JSON.parse(readFileSync(join(BUILD_DIR, "manifest.json"), "utf8"));
const zip = new JSZip();

function add(directory, prefix) {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    const name = prefix ? posix.join(prefix, entry) : entry;
    if (statSync(full).isDirectory()) {
      add(full, name);
      continue;
    }
    zip.file(name, readFileSync(full));
  }
}

add(BUILD_DIR, "");

// Fixed compression and no timestamps would be nicer for reproducibility, but
// JSZip stamps entries with the current time and the Web Store does not care.
const archive = await zip.generateAsync({
  type: "nodebuffer",
  compression: "DEFLATE",
  compressionOptions: { level: 9 },
});

mkdirSync(OUT_DIR, { recursive: true });
const target = join(OUT_DIR, `webspaces-${manifest.version}.zip`);
writeFileSync(target, archive);

const files = Object.keys(zip.files).filter((name) => !zip.files[name].dir).length;
console.log("");
console.log(`${target}  (${files} files, ${(archive.length / 1024).toFixed(1)} kB)`);
console.log("");
console.log("To install it by hand: unzip, then chrome://extensions, Developer mode,");
console.log("Load unpacked, and pick the unzipped folder.");
console.log("To publish: upload this file in the Chrome Web Store developer dashboard.");
