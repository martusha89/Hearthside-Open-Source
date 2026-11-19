// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useAppStore } from "../store";
import { CompanionBuilder } from "./CompanionBuilder";
import { ModelPicker } from "./ModelPicker";
import { Spinner } from "./icons";
import { describeCreateError } from "../lib/models";

function NewAgentForm({ onClose, onBack }: { onClose: () => void; onBack: () => void }) {
  const models = useAppStore((state) => state.models);
  const createAgent = useAppStore((state) => state.createAgent);
  const openSettings = useAppStore((state) => state.openSettings);
  // Hearthside: no model provider connected yet; the agent is created without one.
  const needsProvider = useAppStore(
    (state) => state.providers !== null && !state.providers.some((provider) => provider.connections.length > 0),
  );
  const [name, setName] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      await createAgent({ name, ...(model && !needsProvider ? { model } : {}) });
      onClose();
    } catch (failure) {
      setError(describeCreateError(failure instanceof Error ? failure.message : String(failure)));
      setCreating(false);
    }
  };

  return (
    <form
      className="mt-4 grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim() && !creating) void create();
      }}
    >
      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-ink-700">Name</span>
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="My agent"
          className="field"
        />
      </label>
      {needsProvider ? (
        <div className="rounded-xl border border-border bg-surface-secondary px-3 py-2.5 text-xs text-ink-800">
          <span className="block font-medium text-ink-900">No model connected yet. That's fine.</span>
          The agent can be created now and get a model afterwards: a ChatGPT or Claude plan, an API key, or a local server like Ollama.
          <button
            type="button"
            className="mt-1.5 block text-accent hover:underline"
            onClick={() => {
              onClose();
              openSettings("providers");
            }}
          >
            Connect a model first
          </button>
        </div>
      ) : (
        <div className="grid gap-1.5">
          <span className="text-xs font-medium text-ink-700">Model</span>
          <ModelPicker value={model} models={models} onChange={setModel} placement="bottom" />
          <span className="text-xs text-muted">You can switch models per chat later.</span>
        </div>
      )}
      {error && <p className="break-words text-xs text-error">{error}</p>}
      <div className="flex items-center justify-between gap-2">
        <button type="button" className="text-xs text-muted hover:text-ink-800 hover:underline" onClick={onBack} disabled={creating}>
          ← Other ways to start
        </button>
        <div className="flex gap-2">
          <button type="button" className="button-secondary" onClick={onClose} disabled={creating}>
            Cancel
          </button>
          <button type="submit" className="button-primary" disabled={!name.trim() || creating}>
            {creating && <Spinner className="h-3.5 w-3.5" />}
            {creating ? "Creating" : "Create agent"}
          </button>
        </div>
      </div>
    </form>
  );
}

/** Hearthside: how to start: build a companion, or a blank agent. */
function StartChoice({ onPick }: { onPick: (mode: "companion" | "blank") => void }) {
  const options = [
    { mode: "companion" as const, title: "Companion", text: "Start with who they are, who you are, and how you work together. Their memory starts with all of it." },
    { mode: "blank" as const, title: "Blank agent", text: "Just a name and a model. It learns as you talk." },
  ];
  return (
    <div className="mt-4 grid gap-2">
      {options.map((option) => (
        <button
          key={option.mode}
          type="button"
          onClick={() => onPick(option.mode)}
          className="grid gap-0.5 rounded-xl border border-border p-3.5 text-left transition-colors hover:border-accent hover:bg-accent-subtle"
        >
          <span className="text-sm font-semibold text-ink-900">{option.title}</span>
          <span className="text-xs text-muted">{option.text}</span>
        </button>
      ))}
    </div>
  );
}

export function NewAgentDialog() {
  const open = useAppStore((state) => state.newAgentOpen);
  const setNewAgentOpen = useAppStore((state) => state.setNewAgentOpen);
  const start = useAppStore((state) => state.newAgentStart);
  const [mode, setMode] = useState<"choose" | "companion" | "blank">("choose");
  // Opened straight on the builder (from the welcome guide).
  useEffect(() => {
    if (open) setMode(start);
  }, [open, start]);
  const close = () => {
    setNewAgentOpen(false);
    setMode("choose");
  };
  const wide = mode === "companion";

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? setNewAgentOpen(true) : close())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px]" />
        <Dialog.Content
          className={`fixed left-1/2 top-1/2 z-50 flex w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-border bg-surface p-5 shadow-elevated focus:outline-none ${wide ? "h-[min(46rem,calc(100vh-2rem))] max-w-2xl" : "max-w-md"}`}
        >
          <Dialog.Title className="text-base font-semibold text-ink-900">{mode === "companion" ? "New companion" : "New agent"}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-muted">
            {mode === "companion"
              ? "Three short pages, then you review exactly what goes into their memory."
              : "An agent keeps its own memory across every chat you have with it."}
          </Dialog.Description>
          {open && mode === "choose" && <StartChoice onPick={setMode} />}
          {open && mode === "blank" && <NewAgentForm onClose={close} onBack={() => setMode("choose")} />}
          {open && mode === "companion" && <CompanionBuilder onClose={close} onBack={() => setMode("choose")} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
