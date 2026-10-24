const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const output = path.join(root, "dist");
const files = ["index.html", "assets/styles.css", "assets/app.js"];

// Refuse unexpected output instead of publishing or deleting stale files.
for (const [folder, allowed] of [
  [output, ["index.html", "assets"]],
  [path.join(output, "assets"), ["styles.css", "app.js"]]
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
console.log(`Prepared ${files.length} website files in dist. No deployment performed.`);
