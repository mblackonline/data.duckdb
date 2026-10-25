const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const output = path.join(root, "dist");
const files = [
  "index.html", "about.html", "auth-redirect.html", "_headers", "assets/styles.css", "assets/app.js",
  "assets/staff-auth.mjs", "assets/staff-config.json", "assets/auth-redirect.js"
];
const vendorFiles = {
  "assets/msal-browser.min.js": "node_modules/@azure/msal-browser/lib/msal-browser.min.js",
  "assets/msal-redirect-bridge.min.js": "node_modules/@azure/msal-browser/lib/redirect-bridge/msal-redirect-bridge.min.js",
  "assets/msal-license.txt": "node_modules/@azure/msal-browser/LICENSE"
};
const publishFiles = [...files, ...Object.keys(vendorFiles)];

// Refuse unexpected output instead of publishing or deleting stale files.
for (const [folder, allowed] of [
  [output, ["index.html", "about.html", "auth-redirect.html", "_headers", "assets"]],
  [path.join(output, "assets"), publishFiles.filter(file => file.startsWith("assets/")).map(file => path.basename(file))]
]) {
  if (!fs.existsSync(folder)) continue;
  if (!fs.lstatSync(folder).isDirectory()) {
    throw new Error(`Expected a regular directory: ${folder}`);
  }
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const expectedType = entry.name === "assets" ? entry.isDirectory() : entry.isFile();
    if (!allowed.includes(entry.name) || !expectedType) {
      throw new Error(`Unexpected publish entry: ${path.join(folder, entry.name)}. Review it before rebuilding.`);
    }
  }
}

fs.mkdirSync(path.join(output, "assets"), { recursive: true });
for (const file of files) {
  fs.copyFileSync(path.join(root, file), path.join(output, file));
}
for (const [file, source] of Object.entries(vendorFiles)) {
  fs.copyFileSync(path.join(root, source), path.join(output, file));
}
console.log(`Prepared ${publishFiles.length} website files in dist. No deployment performed.`);
