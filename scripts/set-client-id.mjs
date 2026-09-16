// Stores the Google OAuth client id and rebuilds in one go.
//
// Chrome reads the client id from the extension manifest and offers no way to
// hand it one at runtime, so this value has to be baked in at build time. A
// script rather than a shell redirect keeps the instruction identical on
// PowerShell and on a POSIX shell, and avoids the byte order mark that
// PowerShell would otherwise write into the file.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const CLIENT_ID_FILE = "google-client-id.txt";
const clientId = process.argv[2]?.trim();

if (!clientId) {
  console.error("Usage: npm run client-id -- <client-id>");
  process.exit(1);
}

if (!clientId.endsWith(".apps.googleusercontent.com")) {
  console.error("That does not look like a Google client id.");
  console.error("It should end with .apps.googleusercontent.com");
  process.exit(1);
}

writeFileSync(CLIENT_ID_FILE, `${clientId}\n`);
console.log(`Saved to ${CLIENT_ID_FILE}, which is gitignored.`);

const build = spawnSync(process.execPath, ["build.mjs"], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

console.log("");
console.log("Now reload the extension at chrome://extensions and press Connect.");
