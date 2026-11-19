import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { app } from "electron";

/**
 * Hearthside: run "npx some-mcp-server" connectors without npm in the loop.
 *
 * On Windows, npx starts the server through npm, which opens its own console
 * window (Hearthside's windowsHide doesn't reach npm's children), so a window
 * flashed every time an agent's connectors started. Instead, the package is
 * installed once into Hearthside's own folder and then run directly with
 * Hearthside's built-in Node, hidden. Packages with a pinned version stay at it;
 * unpinned ones are installed once (remove and re-add a connector to update it).
 */

const NPX_NAMES = new Set(["npx", "npx.cmd", "npx.exe"]);

/** "npx -y @scope/pkg@1.2 --flag x" → the package and the server's own arguments. */
export function parseNpx(command: string, args: string[]): { spec: string; name: string; rest: string[] } | null {
  if (!NPX_NAMES.has(basename(command).toLowerCase())) return null;
  const list = [...args];
  while (list.length && /^-/.test(list[0]!)) {
    const flag = list.shift()!;
    // "-p <package> <command>" names the package and the command separately,
    // and a registry or cache says where it comes from. Dropping those and
    // installing the next word ran a different package: the *command's* name,
    // from the public registry, with the connector's keys in its environment.
    // Those forms are left to npx itself, exactly as they were written.
    if (/^(--package|-p|--registry|--cache|--userconfig|--prefix)(=|$)/.test(flag)) return null;
  }
  const spec = list.shift();
  if (!spec) return null;
  const name = spec.startsWith("@") ? `@${spec.slice(1).split("@")[0]}` : spec.split("@")[0]!;
  if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name)) return null;
  return { spec, name, rest: list };
}

function packagesRoot(): string {
  return join(app.getPath("userData"), "mcp-packages");
}

function folderFor(spec: string): string {
  return join(packagesRoot(), spec.replace(/[^a-z0-9._-]+/gi, "_"));
}

/** npm's own script, found next to npx on PATH. */
function npmCli(): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const candidate of [join(dir, "node_modules", "npm", "bin", "npm-cli.js"), join(dirname(dir), "lib", "node_modules", "npm", "bin", "npm-cli.js")]) {
      if (existsSync(candidate) && (existsSync(join(dir, "npx.cmd")) || existsSync(join(dir, "npx")))) return candidate;
    }
  }
  return null;
}

/** The package's command-line entry point (its "bin"). */
export function binOf(packageDir: string, name: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
    if (typeof pkg.bin === "string") return join(packageDir, pkg.bin);
    if (pkg.bin && typeof pkg.bin === "object") {
      const short = name.split("/").pop() ?? name;
      const entry = pkg.bin[short] ?? Object.values(pkg.bin)[0];
      return entry ? join(packageDir, entry) : null;
    }
  } catch {
    // Not installed.
  }
  return null;
}

const installing = new Map<string, Promise<string>>();

/** Install the package once (hidden) and return its entry point. */
async function ensureInstalled(spec: string, name: string): Promise<string> {
  const folder = folderFor(spec);
  const packageDir = join(folder, "node_modules", ...name.split("/"));
  const existing = binOf(packageDir, name);
  if (existing && existsSync(existing)) return existing;
  const pending = installing.get(spec);
  if (pending) return pending;
  const work = (async () => {
    const cli = npmCli();
    if (!cli) throw new Error("This connector needs Node.js and npm installed (npx wasn't found).");
    mkdirSync(folder, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, "install", "--prefix", folder, "--no-fund", "--no-audit", "--omit=dev", "--loglevel=error", spec], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => (output = (output + chunk.toString()).slice(-4_000)));
      child.stderr?.on("data", (chunk: Buffer) => (output = (output + chunk.toString()).slice(-4_000)));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Installing ${name} took too long.`));
      }, 5 * 60_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Couldn't install ${name}: ${output.trim().split("\n").slice(-2).join(" ").slice(0, 300)}`));
      });
    });
    const bin = binOf(packageDir, name);
    if (!bin || !existsSync(bin)) throw new Error(`${name} installed, but it has no command to run.`);
    return bin;
  })();
  installing.set(spec, work);
  try {
    return await work;
  } finally {
    installing.delete(spec);
  }
}

/**
 * For an npx connector, how to run it directly: Hearthside's Node, the package's
 * entry point, the server's own arguments. Null when it isn't an npx command.
 */
export async function directNpx(command: string, args: string[]): Promise<{ command: string; args: string[]; env: Record<string, string> } | null> {
  const parsed = parseNpx(command, args);
  if (!parsed) return null;
  const bin = await ensureInstalled(parsed.spec, parsed.name);
  return { command: process.execPath, args: [bin, ...parsed.rest], env: { ELECTRON_RUN_AS_NODE: "1" } };
}
