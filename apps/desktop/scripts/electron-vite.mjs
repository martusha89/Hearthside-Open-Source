// Runs electron-vite with ELECTRON_RUN_AS_NODE removed. Some terminals (for
// example VS Code's) export it, which makes Electron start as plain Node and
// crash on `app` being undefined.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
// The bin file is not in the package's "exports", so locate it via package.json.
const pkgPath = require.resolve("electron-vite/package.json");
const cli = join(dirname(pkgPath), require(pkgPath).bin["electron-vite"]);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 1));
