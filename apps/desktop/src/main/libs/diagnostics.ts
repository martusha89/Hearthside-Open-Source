import { app } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Diagnostics } from "@hearthside/ipc-contract";
import { resolveLettaCli, resolveRuntimeHome } from "../runtime/paths";
import { logFilePath } from "./log-file";

/** Hearthside: what to look at (or send) when something goes wrong. */
export function getDiagnostics(): Diagnostics {
  const path = logFilePath();
  let tail = "";
  if (existsSync(path)) {
    const text = readFileSync(path, "utf8");
    tail = text.split(/\r?\n/).slice(-200).join("\n");
  }
  let runtimeVersion: string | null = null;
  try {
    // The package's exports don't include package.json; read it next to the CLI.
    runtimeVersion = (JSON.parse(readFileSync(join(dirname(resolveLettaCli()), "package.json"), "utf8")) as { version: string }).version;
  } catch {
    // Not found.
  }
  const { home, sandbox } = resolveRuntimeHome();
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? "",
    runtimeVersion,
    platform: `${process.platform} ${process.arch}`,
    logPath: path,
    logTail: tail,
    lettaHome: home ?? `${join(app.getPath("home"), ".letta")} (your own)`,
    sandbox,
  };
}
