// Extension build: esbuild bundles four entry points, the rest is asset copying.
import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const outdir = "dist";

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

/** Assets copied to the output directory unchanged. */
async function copyAssets() {
  await cp("manifest.json", `${outdir}/manifest.json`);
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
}
