import { useEffect, useRef, useState } from "react";
import type { ModFileInfo, ModImportPreview, ModScopeInfo, ModSourceView, ModsOverview } from "../types";
import { useAppStore } from "../store";

/**
 * Settings → Mods.
 *
 * Mods are Letta Code's own extensions, and the runtime Hearthside starts
 * already loads them. This screen makes that legible: the folder the runtime
 * will really read, what is in it, each file's source, what the runtime says
 * it has loaded, its own diagnostics file, and the one switch that keeps mods
 * from loading at all.
 *
 * What it deliberately does not do: pretend to manage anything the runtime has
 * no interface for. There are no per-mod toggles, because enable/disable is a
 * `packages.json` flag for managed packages only and the native CLI refuses it
 * for a companion's mods. See docs/MODS.md.
 */

const ruleText: Record<ModScopeInfo["rule"], string> = {
  LETTA_MODS_DIR: "set by LETTA_MODS_DIR in the environment Hearthside was started from",
  LETTA_EXTENSIONS_DIR: "set by the older LETTA_EXTENSIONS_DIR in the environment Hearthside was started from",
  default: "the runtime's usual place, inside the Letta folder Hearthside runs against",
  "legacy-default": "the older extensions folder, which this runtime still reads",
  "agent-memory": "inside this companion's own memory",
};

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${Math.round(bytes / 1024)} KB`;
}

function when(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleString() : "unknown";
}

export function ModsPanel() {
  const agentId = useAppStore((state) => state.agentId);
  const epoch = useAppStore((state) => state.backendEpoch);
  // Remount on any scope change: no previous runtime's or companion's file
  // list, source or import preview survives a single render.
  return <ScopedMods key={JSON.stringify([epoch, agentId])} agentId={agentId} />;
}

function ScopedMods({ agentId }: { agentId: string | null }) {
  const [overview, setOverview] = useState<ModsOverview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(true);
  const [source, setSource] = useState<ModSourceView | null>(null);
  const [preview, setPreview] = useState<ModImportPreview | null>(null);
  const alive = useRef(false);
  const locked = useRef(true);
  const activeId = useAppStore((state) => state.activeId);
  const conversations = useAppStore((state) => state.conversations);

  const load = async () => {
    const { backendEpoch, agentId: currentAgent } = useAppStore.getState();
    const next = await window.bridge.getModsOverview(agentId);
    const current = useAppStore.getState();
    if (!alive.current || current.backendEpoch !== backendEpoch || current.agentId !== currentAgent) return;
    setOverview(next);
  };
  useEffect(() => {
    alive.current = true;
    void load()
      .catch((failure: unknown) => {
        if (alive.current) setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => {
        if (alive.current) {
          locked.current = false;
          setBusy(false);
        }
      });
    return () => {
      alive.current = false;
    };
  }, []);

  const run = async (work: () => Promise<unknown>) => {
    if (locked.current) return;
    const { backendEpoch, agentId: currentAgent } = useAppStore.getState();
    const mine = () => alive.current && useAppStore.getState().backendEpoch === backendEpoch && useAppStore.getState().agentId === currentAgent;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
      if (mine()) await load();
    } catch (failure) {
      if (mine()) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (alive.current) {
        locked.current = false;
        setBusy(false);
      }
    }
  };

  const showSource = (scope: "machine" | "agent", file: ModFileInfo) =>
    run(async () => {
      setSource(null);
      const view = await window.bridge.readModSource({ scope, agentId, name: file.name });
      if (alive.current) setSource(view);
    });

  const addFile = () =>
    run(async () => {
      setNotice("");
      const chosen = await window.bridge.chooseModFile();
      if (alive.current) setPreview(chosen);
    });

  const confirmAdd = (token: string) =>
    run(async () => {
      const result = await window.bridge.confirmModImport(token);
      if (!alive.current) return;
      setPreview(null);
      setNotice(`Added ${result.name}. It loads the next time the runtime reads its mods — use Reload below, or restart Hearthside.`);
    });

  const reload = () =>
    run(async () => {
      const conversationId = activeId ?? conversations.find((item) => item.main)?.id ?? null;
      if (!conversationId) throw new Error("Open a chat first, so there is a companion to reload for.");
      const { backendEpoch, agentId } = useAppStore.getState();
      const result = await window.bridge.reloadMods(conversationId);
      const current = useAppStore.getState();
      if (!alive.current || current.backendEpoch !== backendEpoch || current.agentId !== agentId) return;
      if (result.uncertain || (result.startedTurn && !result.turnFinished)) {
        setNotice(result.output || "Reload may still be running. Wait for the runtime to confirm its status.");
        return;
      }
      setNotice(result.output || "Asked the runtime to reload.");
      if (result.success !== false) await current.loadChatCommands(conversationId);
    });

  const setOff = (off: boolean) =>
    run(async () => {
      const state = await window.bridge.setModsOff(off);
      if (!alive.current) return;
      setNotice(
        state.reason === "environment"
          ? `Mods stay off because ${state.variable} is set in the environment Hearthside was started from. Hearthside doesn't change that variable.`
          : state.needsRestart
            ? "Saved. The runtime is restarting so it takes effect."
            : "Saved.",
      );
    });

  return (
    <section className="mt-4 grid min-w-0 gap-6 break-words text-sm text-ink-900" aria-label="Mods">
      <div className="grid gap-2">
        <h3 className="font-medium">Mods</h3>
        <p className="text-muted">
          Mods are Letta Code's own extensions: small files the runtime loads, which can add tools, slash
          commands, hooks into replies, and permission checks. Hearthside reads them here and shows them;
          only the runtime runs them.
        </p>
        <p className="rounded-lg bg-accent-subtle px-3 py-2 text-xs text-ink-800">
          <strong>A mod is fully trusted code.</strong> When the runtime loads one it runs that file with the
          same access the runtime itself has: your files, your network, your programs. There is no sandbox
          and no permission prompt for the mod file itself. Only add mods you have read, or that come from
          someone you trust with all of that.
        </p>
        {busy && <p role="status" className="text-muted">Working…</p>}
        {notice && <p role="status" className="text-muted">{notice}</p>}
        {error && <p role="alert" className="text-error">{error}</p>}
        {!overview && !busy && (
          <button type="button" className="button-secondary justify-self-start" onClick={() => void run(load)}>
            Retry
          </button>
        )}
      </div>

      {overview && (
        <>
          <OffSwitch overview={overview} busy={busy} onChange={setOff} />
          {overview.executionComputer && (
            <p className="rounded-lg border border-border px-3 py-2 text-xs text-muted">
              This Cloud connection runs tools on <strong>{overview.executionComputer}</strong>. That computer
              loads its own mods, and Hearthside can neither list nor run them from here.
            </p>
          )}

          <Scope
            info={overview.machine}
            title="This computer"
            busy={busy}
            canAdd={!overview.machine.readOnly && overview.machine.inspectable}
            onShow={(file) => void showSource("machine", file)}
            onAdd={() => void addFile()}
          />

          {overview.agent ? (
            <Scope
              info={overview.agent}
              title="This companion"
              busy={busy}
              canAdd={false}
              onShow={(file) => void showSource("agent", file)}
            />
          ) : (
            <p className="text-xs text-muted">
              {agentId
                ? "This companion has no mods folder. One appears when its memory is live and a mods folder exists in it."
                : "Open a companion to see the mods that belong to it."}
            </p>
          )}

          <Advertised overview={overview} busy={busy} onReload={() => void reload()} />
          <Capabilities overview={overview} />
          <Diagnostics overview={overview} />
        </>
      )}

      {preview && <ImportPreview preview={preview} busy={busy} onConfirm={() => void confirmAdd(preview.token)} onCancel={() => setPreview(null)} />}
      {source && <SourceView view={source} onClose={() => setSource(null)} />}
    </section>
  );
}

function OffSwitch({ overview, busy, onChange }: { overview: ModsOverview; busy: boolean; onChange: (off: boolean) => void }) {
  const { off } = overview;
  const forced = off.reason === "environment";
  return (
    <div className="grid gap-2">
      <h3 className="font-medium">Turn mods off</h3>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={off.active}
          disabled={busy || forced}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>
          <span className="block">Don't load any mods</span>
          <span className="block text-xs text-muted">
            Sets LETTA_DISABLE_MODS for every runtime Hearthside starts, so nothing is loaded — not this
            computer's mods and not a companion's. Use this if a mod stops Hearthside working. It only applies
            when the runtime starts, so changing it restarts the runtime; reloading cannot turn mods back on.
          </span>
        </span>
      </label>
      {forced && (
        <p className="text-xs text-muted">
          Mods are already off because <code>{off.variable}</code> is set in the environment Hearthside was
          started from. Hearthside never changes that variable; unset it and restart Hearthside to use the
          switch here.
        </p>
      )}
    </div>
  );
}

function Scope({
  info,
  title,
  busy,
  canAdd,
  onShow,
  onAdd,
}: {
  info: ModScopeInfo;
  title: string;
  busy: boolean;
  canAdd: boolean;
  onShow: (file: ModFileInfo) => void;
  onAdd?: () => void;
}) {
  return (
    <div className="grid gap-2">
      <h3 className="font-medium">{title}</h3>
      <p className="break-all font-mono text-xs text-muted">{info.directory ?? "no folder"}</p>
      <p className="text-xs text-muted">
        {ruleText[info.rule]}
        {info.inspectable && !info.exists && " · doesn't exist yet"}
        {info.readOnly && info.inspectable && " · read-only here"}
      </p>
      {info.note && <p className="text-xs text-muted">{info.note}</p>}
      {info.packagesProblem && <p role="alert" className="text-xs text-error">{info.packagesProblem}</p>}

      {!info.inspectable ? null : info.files.length === 0 ? (
        <p className="text-xs text-muted">No mod files here.</p>
      ) : (
        <ul className="grid gap-1">
          {info.files.map((file) => (
            <li key={file.path} className="flex flex-wrap items-baseline gap-2 rounded-lg border border-border px-3 py-2">
              <span className="font-mono text-xs text-ink-900">{file.name}</span>
              {file.linkTarget ? (
                <span className="text-xs text-muted">
                  a link to <span className="break-all font-mono">{file.linkTarget}</span> — the runtime
                  follows it, Hearthside won't
                </span>
              ) : (
                <span className="text-xs text-muted">
                  {size(file.bytes)} · changed {when(file.modifiedAt)}
                  {file.tooLarge && " · too big to show in full"}
                </span>
              )}
              {!file.linkTarget && (
                <button type="button" className="button-secondary ml-auto" disabled={busy} onClick={() => onShow(file)}>
                  Read it
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {info.packages.length > 0 && (
        <div className="grid gap-1">
          <p className="text-xs font-medium">Installed packages</p>
          <ul className="grid gap-1">
            {info.packages.map((item) => (
              <li key={item.source} className="rounded-lg border border-border px-3 py-2 text-xs">
                <span className="font-mono text-ink-900">{item.source}</span>
                {item.version && <span className="text-muted"> {item.version}</span>}
                <span className="text-muted"> · {item.enabled ? "on" : "off"} in packages.json</span>
                <span className="mt-1 block text-muted">
                  Turning a package on or off is <code>letta mods enable</code> / <code>letta mods disable</code>{" "}
                  in a terminal. Hearthside shows this file but doesn't change it.
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {canAdd && onAdd && (
        <button type="button" className="button-secondary justify-self-start" disabled={busy} onClick={onAdd}>
          Add a mod file…
        </button>
      )}
    </div>
  );
}

function Advertised({ overview, busy, onReload }: { overview: ModsOverview; busy: boolean; onReload: () => void }) {
  const advertised = overview.advertised;
  return (
    <div className="grid gap-2">
      <h3 className="font-medium">What the runtime has loaded</h3>
      <p className="text-xs text-muted">
        The runtime only tells Hearthside about the slash commands a mod registered — not its tools, hooks or
        permission checks, and not which file each one came from. A file listed above with no command here may
        still have loaded and be doing something.
      </p>
      {advertised ? (
        advertised.commands.length === 0 ? (
          <p className="text-xs text-muted">No mod commands, as of {when(advertised.asOf)}.</p>
        ) : (
          <ul className="grid gap-1">
            {advertised.commands.map((command) => (
              <li key={command.id} className="flex flex-wrap items-baseline gap-2 rounded-lg border border-border px-3 py-2 text-xs">
                <span className="font-mono text-ink-900">/{command.id}</span>
                {command.argument && <span className="font-mono text-muted">{command.argument}</span>}
                <span className="text-muted">{command.description}</span>
              </li>
            ))}
          </ul>
        )
      ) : (
        <p className="text-xs text-muted">{overview.advertisedError ?? "Not asked yet."}</p>
      )}
      <button type="button" className="button-secondary justify-self-start" disabled={busy} onClick={onReload}>
        Reload mods
      </button>
      <p className="text-xs text-muted">
        This is the runtime's own reload: settings, this computer's mods, the open companion's mods and its
        secrets, all together. It needs the chat to be idle, and it can't turn mods back on if they are off.
      </p>
    </div>
  );
}

function Capabilities({ overview }: { overview: ModsOverview }) {
  return (
    <div className="grid gap-2">
      <h3 className="font-medium">What a mod is offered here</h3>
      <p className="text-xs text-muted">
        What this runtime advertises to a mod. It isn't a guarantee, and it isn't a sandbox: a "no" means the
        matching call does nothing, not that the mod is prevented from doing it another way.
      </p>
      <ul className="grid gap-1">
        {overview.capabilities.map((capability) => (
          <li key={capability.id} className="flex flex-wrap items-baseline gap-2 rounded-lg border border-border px-3 py-2 text-xs">
            <span className="text-ink-900">{capability.name}</span>
            <span className="ml-auto text-muted">
              this computer: {capability.machine ? "yes" : "no"} · a companion's: {capability.agent ? "yes" : "no"}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">
        Panels are off, so mods can't draw anything in Hearthside yet. Side panels and pop-outs are a separate
        piece of work.
      </p>
    </div>
  );
}

function Diagnostics({ overview }: { overview: ModsOverview }) {
  const diagnostics = overview.diagnostics;
  if (!diagnostics) return null;
  return (
    <div className="grid gap-2">
      <h3 className="font-medium">Problems the runtime recorded</h3>
      <p className="break-all font-mono text-xs text-muted">{diagnostics.path}</p>
      <p className="text-xs text-muted">
        Written {when(diagnostics.generatedAt)} · {diagnostics.errors} error
        {diagnostics.errors === 1 ? "" : "s"}, {diagnostics.warnings} warning{diagnostics.warnings === 1 ? "" : "s"}.
        A mod that loaded cleanly leaves nothing here, and this file doesn't cover every companion, so it isn't
        a list of what's loaded.
      </p>
      <ul className="grid gap-1">
        {diagnostics.entries.map((entry, index) => (
          <li key={`${entry.modPath}:${entry.at}:${index}`} className="rounded-lg border border-border px-3 py-2 text-xs">
            <span className={entry.severity === "error" ? "text-error" : "text-ink-900"}>{entry.severity}</span>
            <span className="text-muted"> · {entry.phase}</span>
            {entry.modPath && <span className="ml-1 break-all font-mono text-muted">{entry.modPath}</span>}
            <span className="mt-1 block">{entry.message}</span>
            {entry.hint && <span className="mt-1 block text-muted">{entry.hint}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ImportPreview({
  preview,
  busy,
  onConfirm,
  onCancel,
}: {
  preview: ModImportPreview;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="grid gap-2 rounded-xl border border-accent px-4 py-3">
      <h3 className="font-medium">Add {preview.name}?</h3>
      <p className="text-xs text-muted">
        {size(preview.bytes)} · from <span className="break-all font-mono">{preview.from}</span>
      </p>
      <p className="text-xs text-muted">
        It will be copied to <span className="break-all font-mono">{preview.target}</span>. Nothing has been
        written yet, and nothing already there is replaced.
      </p>
      <p className="rounded-lg bg-accent-subtle px-3 py-2 text-xs text-ink-800">
        Read it first. Once the runtime loads this file it runs it, with all the access the runtime has.
      </p>
      <pre className="max-h-80 overflow-auto rounded-lg bg-surface-secondary p-3 text-xs">{preview.source}</pre>
      <div className="flex gap-2">
        <button type="button" className="button-primary" disabled={busy} onClick={onConfirm}>
          I've read it — add it
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function SourceView({ view, onClose }: { view: ModSourceView; onClose: () => void }) {
  return (
    <div className="grid gap-2 rounded-xl border border-border px-4 py-3">
      <div className="flex items-baseline gap-2">
        <h3 className="font-medium">{view.name}</h3>
        <button type="button" className="button-secondary ml-auto" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="break-all font-mono text-xs text-muted">{view.path}</p>
      <p className="text-xs text-muted">
        {size(view.bytes)}
        {view.truncated && " · only the first part is shown"} · read as text, never run
      </p>
      <pre className="max-h-96 overflow-auto rounded-lg bg-surface-secondary p-3 text-xs">{view.source}</pre>
    </div>
  );
}
