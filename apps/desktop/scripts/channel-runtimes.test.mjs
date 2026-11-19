import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareChannelRuntimes, validateChannelSpec } from "./channel-runtimes.mjs";

const specs = join(dirname(fileURLToPath(import.meta.url)), "..", "channel-runtimes");
function temporary(run) {
  const root = mkdtempSync(join(tmpdir(), "hearthside-channels-test-"));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("stale or wrong markers never bypass clean installation with the source lock", () => temporary((root) => {
  const marker = join(root, "telegram", "runtime", "node_modules", "grammy", "package.json");
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, JSON.stringify({ version: "0.0.0" }));
  let calls = 0;
  const install = (command, options) => {
    calls++;
    assert.equal(command, "npm ci --workspaces=false --omit=dev --no-audit --no-fund --ignore-scripts");
    const channel = options.cwd.includes(`${join("telegram", "runtime")}`) ? "telegram" : "discord";
    for (const file of ["package.json", "package-lock.json"]) {
      assert.deepEqual(readFileSync(join(options.cwd, file)), readFileSync(join(specs, channel, file)));
    }
  };
  prepareChannelRuntimes({ root, install });
  // Even a matching marker must never authorize reuse of an unverified tree.
  writeFileSync(marker, JSON.stringify({ version: "1.42.0" }));
  prepareChannelRuntimes({ root, install });
  assert.equal(calls, 4);
}));

test("installation failure propagates and stops later channel preparation", () => temporary((root) => {
  let calls = 0;
  assert.throws(() => prepareChannelRuntimes({ root, install() { calls++; throw new Error("ci failed"); } }), /ci failed/);
  assert.equal(calls, 1);
}));

test("source specs pin expected direct versions and registry integrity for every package", () => {
  for (const channel of ["telegram", "discord"]) {
    const manifest = JSON.parse(readFileSync(join(specs, channel, "package.json")));
    const lock = JSON.parse(readFileSync(join(specs, channel, "package-lock.json")));
    validateChannelSpec(channel, manifest, lock);
    assert.throws(() => validateChannelSpec(channel, { ...manifest, dependencies: { invalid: "1.0.0" } }, lock), /dependencies/);
    const broken = structuredClone(lock);
    broken.packages[""].dependencies = {};
    assert.throws(() => validateChannelSpec(channel, manifest, broken), /dependencies/);
    const unpinned = structuredClone(lock);
    delete Object.values(unpinned.packages).find((entry) => entry.integrity).integrity;
    assert.throws(() => validateChannelSpec(channel, manifest, unpinned), /integrity/);
  }
  assert.throws(() => validateChannelSpec("unknown", {}, {}), /Unknown channel/);
});
