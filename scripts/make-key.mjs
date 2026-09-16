// Generates the key pair that pins the extension ID.
//
// An unpacked extension normally derives its ID from the directory path, which
// means the ID changes when you move the project and differs on every machine.
// That would force a new OAuth client for each install. With a "key" in the
// manifest the ID is fixed forever, so the Google Cloud registration is done
// once for the project and every machine afterwards only has to press Connect.
//
// The public half is safe to share; the private half is what proves ownership,
// so both files stay out of git.
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

const PUBLIC_FILE = "extension-key.txt";
const PRIVATE_FILE = "extension-key.pem";

if (existsSync(PUBLIC_FILE) && !process.argv.includes("--force")) {
  console.error(`${PUBLIC_FILE} already exists.`);
  console.error("Regenerating changes the extension ID and breaks the OAuth client binding.");
  console.error("Pass --force if that is really what you want.");
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "der" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

// Chrome derives the ID from the first 16 bytes of the SHA-256 of the DER key,
// with each hex digit mapped onto the letters a to p.
const digest = createHash("sha256").update(publicKey).digest();
const extensionId = [...digest.subarray(0, 16)]
  .map((byte) => byte.toString(16).padStart(2, "0"))
  .join("")
  .split("")
  .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
  .join("");

writeFileSync(PUBLIC_FILE, `${publicKey.toString("base64")}\n`);
writeFileSync(PRIVATE_FILE, privateKey);

console.log(`Wrote ${PUBLIC_FILE} and ${PRIVATE_FILE} (both gitignored).`);
console.log("");
console.log("Extension ID, stable from now on:");
console.log(`  ${extensionId}`);
console.log("");
console.log("Register this ID once as a Chrome Extension OAuth client, then run npm run build.");
