import { execFile } from "node:child_process";
// Git for Windows can't open Node's os.devNull ("\\.\nul") as a config file or hooks path; it maps "/dev/null" itself.
const devNull = "/dev/null";

/** Capture local history only: never fetch missing objects or run user helpers. */
export function gitBundle(memoryDir: string): Promise<Buffer | null> {
  // An allowlist also excludes GIT_CONFIG_COUNT/PARAMETERS, tracing, exec-path,
  // object/repository redirects, askpass, and dynamic-loader injection variables.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: devNull, GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: "0", GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "", LC_ALL: "C",
  };
  const args = [
    "-c", `core.hooksPath=${devNull}`, "-c", "core.fsmonitor=false",
    "-c", "core.alternateRefsCommand=", "-c", "gc.auto=0", "-c", "maintenance.auto=false",
    "-c", "protocol.allow=never", "bundle", "create", "-", "--all",
  ];
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd: memoryDir, env, windowsHide: true, encoding: "buffer",
      timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 256 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr.length ? stderr : error.message).trim().split("\n").slice(-2).join(" ")));
      else resolve(stdout.length > 0 ? stdout : null);
    });
  });
}
