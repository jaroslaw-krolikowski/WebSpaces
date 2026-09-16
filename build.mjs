// Extension build: esbuild bundles four entry points, the rest is asset copying.
import * as esbuild from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const outdir = "dist";
const CLIENT_ID_FILE = "google-client-id.txt";
const EXTENSION_KEY_FILE = "extension-key.txt";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

/**
 * The OAuth client id is private to an installation, so it does not live in the
 * repository - it comes from an environment variable or a file outside git.
 * Without it the extension works normally, only Drive backup stays disabled.
 */
async function readClientId() {
  if (process.env.GOOGLE_CLIENT_ID) return process.env.GOOGLE_CLIENT_ID.trim();
  return readLocal(CLIENT_ID_FILE);
}

async function readLocal(file) {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch {
    return "";
  }
}

async function writeManifest() {
  const manifest = JSON.parse(await readFile("manifest.json", "utf8"));

  // The key pins the extension ID across machines and moves, which is what makes
  // one OAuth client enough for the whole project. Without it Chrome derives the
  // ID from the directory path and the registration stops matching.
  const extensionKey = await readLocal(EXTENSION_KEY_FILE);
  if (extensionKey) manifest.key = extensionKey;

  const clientId = await readClientId();
  if (clientId) manifest.oauth2 = { client_id: clientId, scopes: [DRIVE_SCOPE] };

  await writeFile(`${outdir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Assets copied to the output directory unchanged. */
async function copyAssets() {
  await writeManifest();
  await cp("src/ui", `${outdir}/ui`, {
    recursive: true,
    filter: (src) => !src.endsWith(".ts"),
  });
  await cp("public/icons", `${outdir}/icons`, { recursive: true });
}

const options = {
  entryPoints: {
    background: "src/background/index.ts",
    "ui/popup": "src/ui/popup.ts",
    "ui/options": "src/ui/options.ts",
    "ui/frozen": "src/ui/frozen.ts",
  },
  bundle: true,
  format: "esm",
  target: "chrome120",
  outdir,
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context({
    ...options,
    plugins: [
      {
        name: "copy-assets",
        setup(build) {
          build.onEnd(() => copyAssets());
        },
      },
    ],
  });
  await ctx.watch();
  console.log("Watch mode. Output directory: dist/");
} else {
  await esbuild.build(options);
  await copyAssets();
  console.log("Done. Load the dist/ directory via chrome://extensions, Load unpacked.");
  console.log(
    (await readLocal(EXTENSION_KEY_FILE))
      ? "Extension ID: pinned by the manifest key."
      : `Extension ID: derived from the folder path (run npm run key to pin it).`,
  );
  console.log(
    (await readClientId())
      ? "Google Drive backup: OAuth client id injected."
      : `Google Drive backup: disabled (no ${CLIENT_ID_FILE}, no GOOGLE_CLIENT_ID).`,
  );
}
