// Syntax-check the plugin's node and client halves, and assert the package
// declares the dsh.client contract the web roster scanner expects.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

const problems = [];
if (manifest.dsh?.client?.platform !== "web") {
  problems.push("missing dsh.client.platform=web declaration");
}
const clientRel = manifest.exports?.["./client"];
if (typeof clientRel !== "string") {
  problems.push('missing exports["./client"]');
}
for (const rel of [manifest.main ?? "lib/index.js", clientRel].filter(Boolean)) {
  const file = join(repoRoot, rel);
  if (!existsSync(file)) {
    problems.push(`${rel} does not exist`);
    continue;
  }
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    problems.push(`${rel} failed node --check:\n${error.stderr}`);
  }
}

if (problems.length > 0) {
  console.error(`check: FAIL ${manifest.name}\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
} else {
  console.log(`check: OK ${manifest.name}`);
}
