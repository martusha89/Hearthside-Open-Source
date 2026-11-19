// Pre-install locked channel libraries into the layout LETTA_CHANNEL_RUNTIME_ROOT
// expects: <root>/<channel>/runtime/{package.json,node_modules}. No scripts run.
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const specs = join(desktop, "channel-runtimes");
// These direct versions match the pinned Letta CLI's channel metadata.
const RUNTIMES = {
  telegram: { grammy: "1.42.0" },
  discord: { "discord.js": "14.18.0" },
};

export function validateChannelSpec(channel, manifest, lock) {
  if (!Object.hasOwn(RUNTIMES, channel)) throw new Error(`Unknown channel: ${channel}`);
  const expected = RUNTIMES[channel];
  if (manifest.name !== `letta-channel-runtime-${channel}` || manifest.private !== true ||
      !isDeepStrictEqual(manifest.dependencies, expected) ||
      !isDeepStrictEqual(lock.packages?.[""]?.dependencies, expected)) {
    throw new Error(`Channel ${channel} dependencies do not match the pinned runtime`);
  }
  if (lock.lockfileVersion !== 3) throw new Error(`Channel ${channel} requires a v3 lockfile`);
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    if (!path.startsWith("node_modules/") || entry.link || !entry.version ||
        !entry.resolved?.startsWith("https://registry.npmjs.org/") ||
        !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? "")) {
      throw new Error(`Channel ${channel} has an unpinned package integrity: ${path}`);
    }
  }
}

export function prepareChannelRuntimes({ root = join(desktop, "build", "channel-runtimes"), install = execSync } = {}) {
  // Validate both source-owned specs before changing generated output.
  for (const channel of Object.keys(RUNTIMES)) {
    validateChannelSpec(channel,
      JSON.parse(readFileSync(join(specs, channel, "package.json"), "utf8")),
      JSON.parse(readFileSync(join(specs, channel, "package-lock.json"), "utf8")));
  }
  for (const channel of Object.keys(RUNTIMES)) {
    const dir = join(root, channel, "runtime");
    mkdirSync(dir, { recursive: true });
    for (const file of ["package.json", "package-lock.json"]) {
      copyFileSync(join(specs, channel, file), join(dir, file));
    }
    // Always run ci: it removes stale/partial node_modules itself. A marker file
    // cannot authenticate the rest of a cached tree. --force remains a no-op.
    console.log(`${channel}: installing locked runtime`);
    // Constant shell command also works with npm.cmd on Windows.
    install("npm ci --workspaces=false --omit=dev --no-audit --no-fund --ignore-scripts", { cwd: dir, stdio: "inherit" });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareChannelRuntimes();
}
