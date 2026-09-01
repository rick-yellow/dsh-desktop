// End-to-end smoke test: boot the pinned `dsh web` profile with every plugin
// in packages/ enabled, then assert the browser roster lists and serves each.
//
// Mirrors a real installation: each package is staged into the profile
// module-resolution fallback ($DSH_HOME/profiles/node_modules), and its
// roster row arrives as a `--patch` overlay. Requires `pnpm install` first
// (the pinned @deepseek-ai/dsh devDependency is the harness under test).

import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dshEntry = join(repoRoot, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const packagesDir = join(repoRoot, "packages");

const plugins = readdirSync(packagesDir)
  .map((entry) => join(packagesDir, entry))
  .filter((dir) => existsSync(join(dir, "package.json")))
  .map((dir) => ({ dir, manifest: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) }));
if (plugins.length === 0) {
  console.error("smoke: FAIL — no plugins under packages/");
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), "dsh-awsome-plugins-smoke-"));
for (const { dir, manifest } of plugins) {
  const staged = join(home, "profiles", "node_modules", manifest.name);
  copyTree(dir, staged, manifest);
}
const overlay = join(home, "smoke.patch.yml");
const rows = plugins
  .map(({ manifest }, index) => `    - id: smoke-${index}\n      name: ${manifest.name}`)
  .join("\n");
writeFileSync(overlay, `- insert:\n${rows}\n`);

function copyTree(dir, staged, manifest) {
  mkdirSync(staged, { recursive: true });
  copyFileSync(join(dir, "package.json"), join(staged, "package.json"));
  const files = [manifest.main ?? "lib/index.js", manifest.exports?.["./client"]].filter(Boolean);
  for (const rel of files) {
    const target = join(staged, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(dir, rel), target);
  }
}

const child = spawn(
  process.execPath,
  [dshEntry, "--profile", "web", "--patch", overlay, "--no-open", "--host", "127.0.0.1", "--port", "0"],
  { env: { ...process.env, DSH_HOME: home, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] },
);

let finished = false;

function fail(message) {
  console.error(`smoke: FAIL — ${message}`);
  cleanup(1);
}

function cleanup(code) {
  finished = true;
  child.kill();
  // The web host spawns children; on Windows take the whole tree down.
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" }).on("close", () => {
      rmSync(home, { recursive: true, force: true, maxRetries: 5 });
      process.exit(code);
    });
  } else {
    rmSync(home, { recursive: true, force: true, maxRetries: 5 });
    process.exit(code);
  }
}

const timeout = setTimeout(() => fail("dsh web did not print its launch line within 120s"), 120_000);

let buffered = "";
child.stdout.on("data", async (chunk) => {
  buffered += String(chunk);
  const match = buffered.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\S*)/);
  if (!match || finished) return;
  clearTimeout(timeout);
  const url = new URL(match[1]);
  try {
    const index = await (await fetch(url)).text();
    for (const { manifest } of plugins) {
      if (!index.includes(manifest.name)) {
        return fail(`boot manifest does not list ${manifest.name}`);
      }
      const bundle = await fetch(new URL(`/plugins/${manifest.name}/client.js`, url));
      const body = await bundle.text();
      if (bundle.status !== 200) {
        return fail(`${manifest.name} client bundle returned ${bundle.status}`);
      }
      if (!body.includes(`id: "${manifest.name}"`)) {
        return fail(`${manifest.name} served bundle does not register itself`);
      }
      console.log(`smoke: OK — ${manifest.name} listed in __DSH_BOOT__ and served (${body.length} bytes)`);
    }
    cleanup(0);
  } catch (error) {
    fail(String(error));
  }
});

child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.on("exit", (code) => {
  if (finished) return;
  clearTimeout(timeout);
  console.error(`smoke: FAIL — dsh web exited early (code ${code})`);
  rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  process.exit(1);
});
