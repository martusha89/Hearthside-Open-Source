// Run after prepare-runtime, with Node >=22.15. No CLI, account or adapter startup.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import childProcess from 'node:child_process';
import dgram from 'node:dgram';

const self = fileURLToPath(import.meta.url);
const isolated = process.argv[2] === '--isolated';
const build = realpathSync(process.argv[isolated ? 3 : 2] ?? join(dirname(self), '..', 'build'));
const root = join(build, 'channel-runtimes');
if (!isolated) {
  const home = mkdtempSync(join(tmpdir(), 'hearthside-channel-smoke-'));
  try {
    const result = spawnSync(process.execPath, ['--no-addons', self, '--isolated', build], {
      cwd: home, stdio: 'inherit', timeout: 60000,
      env: { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
        TMPDIR: home, TMP: home, TEMP: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home,
        ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
        LETTA_CHANNEL_RUNTIME_ROOT: root },
    });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, 'isolated resolver probe failed');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
} else {
  assert.equal(realpathSync(homedir()), realpathSync(process.cwd()));
  assert.match(process.cwd().split(sep).pop(), /^hearthside-channel-smoke-/);
  const blocked = () => { throw new Error('Network and subprocess operations forbidden during resolver smoke'); };
  net.Socket.prototype.connect = net.Server.prototype.listen = dgram.createSocket = globalThis.fetch = blocked;
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[key] = blocked;
  syncBuiltinESMExports();

  // Expose only the pinned runtime's own loaders instead of running its CLI entry.
  // Transform in memory at the original URL to preserve its real resolution context.
  const url = pathToFileURL(join(build, 'patched-runtime', 'letta.js')).href;
  const entry = 'registerBunOAuthFlows();\nawait init_src5().then(() => exports_src2);';
  registerHooks({ load(id, context, next) {
    const loaded = next(id, context);
    if (id !== url) return loaded;
    const source = Buffer.from(loaded.source).toString('utf8');
    assert.equal(source.split(entry).length, 2, 'unexpected prepared runtime entry');
    return { ...loaded, source: source.replace(entry, `init_runtime_deps();
      export { loadGrammyModule, loadDiscordModule, resolveChannelRuntimeModulePath, loadChannelPlugin };`) };
  } });
  const runtime = await import(url);
  for (const [channel, name, load, ctor] of [
    ['telegram', 'grammy', runtime.loadGrammyModule, 'Bot'],
    ['discord', 'discord.js', runtime.loadDiscordModule, 'Client'],
  ]) {
    const resolved = realpathSync(runtime.resolveChannelRuntimeModulePath(channel, name));
    const path = relative(realpathSync(join(root, channel, 'runtime', 'node_modules', name)), resolved);
    assert.ok(path && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path), 'unexpected module source');
    const plugin = await runtime.loadChannelPlugin(channel);
    assert.equal(plugin.metadata.id, channel);
    assert.equal(typeof plugin.createAdapter, 'function');
    const mod = await load();
    assert.equal(mod, await import(pathToFileURL(resolved).href));
    assert.equal(typeof (mod[ctor] ?? mod.default?.[ctor]), 'function');
    console.log(`${channel}: prepared plugin and bundled ${name}.${ctor} loaded`);
  }
}
