import { buildSystemPrompt } from "@letta-ai/letta-code/agent-presets";

// Browser-safe, pinned runtime export. This is never sent back as an override.
// Cloud owns the managed default; this local asset cannot establish its live text.
const reference = buildSystemPrompt("default", "root-memfs");

export function LettaDefaultReference() {
  return <div className="grid min-w-0 gap-1.5">
    <span className="text-xs font-medium text-muted">Letta instructions — bundled reference (read-only)</span>
    <p className="text-xs text-muted">From the Letta Code version bundled with Hearthside, using root-memfs memory. This is not the current Cloud-managed or compiled prompt; its wording may differ. Viewing it does not create a custom override. There is no verified personal/technical boundary to edit here.</p>
    <pre aria-label="Bundled Letta default reference" tabIndex={0} className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-surface-tertiary p-3 text-xs leading-relaxed text-muted">{reference}</pre>
  </div>;
}
