// End-to-end smoke test: boot the pinned `dsh web` profile with the plugin
// (this package) enabled, then assert the browser roster lists and serves it.
//
// Mirrors a real installation: the package is staged into the profile
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
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const dshEntry = join(repoRoot, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const name = manifest.name;

// The package under test is this repo root itself; stage its built halves.
if (!existsSync(join(repoRoot, "lib", "client.js"))) {
  console.error("smoke: FAIL — lib/client.js not found; run pnpm run check first");
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), "dsh-awsome-plugin-smoke-"));
const staged = join(home, "profiles", "node_modules", name);
mkdirSync(staged, { recursive: true });
copyFileSync(join(repoRoot, "package.json"), join(staged, "package.json"));
for (const rel of [manifest.main ?? "lib/index.js", manifest.exports?.["./client"]].filter(Boolean)) {
  const target = join(staged, rel);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(repoRoot, rel), target);
}

const overlay = join(home, "smoke.patch.yml");
writeFileSync(overlay, `- insert:\n    - id: smoke\n      name: ${name}\n`);

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
    if (!index.includes(name)) {
      return fail(`boot manifest does not list ${name}`);
    }
    const bundle = await fetch(new URL(`/plugins/${name}/client.js`, url));
    const body = await bundle.text();
    if (bundle.status !== 200) {
      return fail(`${name} client bundle returned ${bundle.status}`);
    }
    if (!body.includes(`id: "${name}"`)) {
      return fail(`${name} served bundle does not register itself`);
    }
    console.log(`smoke: OK — ${name} listed in __DSH_BOOT__ and served (${body.length} bytes)`);
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
