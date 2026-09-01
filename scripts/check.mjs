// Syntax-check every plugin's node and client halves, and assert each
// package declares the dsh.client contract the web roster scanner expects.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(repoRoot, "packages");

let failures = 0;
for (const entry of readdirSync(packagesDir)) {
  const dir = join(packagesDir, entry);
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const problems = [];
  if (manifest.dsh?.client?.platform !== "web") {
    problems.push("missing dsh.client.platform=web declaration");
  }
  const clientRel = manifest.exports?.["./client"];
  if (typeof clientRel !== "string") {
    problems.push('missing exports["./client"]');
  }
  for (const rel of [manifest.main ?? "lib/index.js", clientRel].filter(Boolean)) {
    const file = join(dir, rel);
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
    failures += 1;
    console.error(`check: FAIL ${manifest.name ?? entry}\n  - ${problems.join("\n  - ")}`);
  } else {
    console.log(`check: OK ${manifest.name}`);
  }
}
process.exit(failures === 0 ? 0 : 1);
