import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../store";
import { COMPANION_PERSONAL, COMPANION_TECHNICAL } from "../lib/companion-prompt";
import { LettaDefaultReference } from "./LettaDefaultReference";
import {
  QUESTIONS,
  RELATIONSHIP_TYPES,
  STEP_FIELDS,
  companionFiles,
  fileIsReady,
  fileHasContent,
  filePath,
  initialDraft,
  companionCreation,
  missingFields,
  type CompanionDraft,
  type CompanionField,
  type CompanionFile,
  type CompanionFileLabel,
} from "../lib/companion";
import { ModelPicker } from "./ModelPicker";
import { describeCreateError } from "../lib/models";
import { CheckIcon, ChevronRightIcon, Spinner } from "./icons";

/**
 * Hearthside: build a companion the way Continuity Studio does: who they are,
 * who you are, how you work together, then review the three memory files
 * before anything is created. Answers are kept between visits until created.
 */

const DRAFT_KEY = "hearthside.companionDraft";
type Step = "ai" | "human" | "relationship" | "review" | "create";
const STEPS: Array<{ id: Step; label: string }> = [
  { id: "ai", label: "Who they are" },
  { id: "human", label: "About you" },
  { id: "relationship", label: "How you work" },
  { id: "review", label: "Review files" },
  { id: "create", label: "Create" },
];
const HEADINGS: Record<"ai" | "human" | "relationship", { title: string; text: string; more: string }> = {
  ai: {
    title: "Start with who they are.",
    text: "A name, identity and voice: what should stay recognisable in every conversation.",
    more: "Add voice, temperament, values, boundaries and agency",
  },
  human: {
    title: "Help them understand you.",
    text: "Who you are, what matters to you, and how you like to be talked to.",
    more: "Add communication, support needs and things to avoid",
  },
  relationship: {
    title: "Write how the relationship works.",
    text: "The trust, decisions and continuity between you. This becomes relationship.md.",
    more: "Add a foundation, decision-making and continuity",
  },
};

type Edits = Partial<Record<CompanionFileLabel, Partial<Pick<CompanionFile, "description" | "value">>>>;


type Saved = { draft: CompanionDraft; edits: Edits; step: Step; preset?: "letta" | "companion"; personal?: string; model?: string | null };

function loadSaved(): Saved | null {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null") as Saved | null;
    return saved?.draft
      ? {
          draft: { ...initialDraft, ...saved.draft },
          edits: saved.edits ?? {},
          step: saved.step ?? "ai",
          ...(saved.preset ? { preset: saved.preset } : {}),
          ...(typeof saved.personal === "string" ? { personal: saved.personal } : {}),
          ...(saved.model !== undefined ? { model: saved.model } : {}),
        }
      : null;
  } catch {
    return null;
  }
}

function Question({ field, draft, onChange }: { field: CompanionField; draft: CompanionDraft; onChange: (field: CompanionField, value: string) => void }) {
  const question = QUESTIONS[field];
  const id = `companion-${field}`;
  return (
    <label className="grid gap-1" htmlFor={id}>
      <span className="text-sm font-medium text-ink-900">
        {question.label}
        {!question.optional && <span className="ml-1 text-xs font-normal text-muted">(needed)</span>}
      </span>
      <span className="text-xs text-muted">{question.hint}</span>
      {question.short ? (
        <input id={id} className="field" value={draft[field]} placeholder={question.placeholder} onChange={(event) => onChange(field, event.target.value)} />
      ) : (
        <textarea id={id} rows={3} className="field resize-y" value={draft[field]} placeholder={question.placeholder} onChange={(event) => onChange(field, event.target.value)} />
      )}
    </label>
  );
}

export function CompanionBuilder({ onClose, onBack }: { onClose: () => void; onBack: () => void }) {
  const models = useAppStore((state) => state.models);
  const createAgent = useAppStore((state) => state.createAgent);
  const openSettings = useAppStore((state) => state.openSettings);
  const setNotice = useAppStore((state) => state.setNotice);
  // Known to have no model provider connected (not merely still loading): the
  // companion can still be created, and picks a model once one is connected.
  const needsProvider = useAppStore(
    (state) => state.providers !== null && !state.providers.some((provider) => provider.connections.length > 0),
  );
  const saved = useMemo(loadSaved, []);
  const [draft, setDraft] = useState<CompanionDraft>(saved?.draft ?? initialDraft);
  const [edits, setEdits] = useState<Edits>(saved?.edits ?? {});
  const [step, setStep] = useState<Step>(saved?.step ?? "ai");
  const [tab, setTab] = useState<CompanionFileLabel>("persona");
  const [preset, setPreset] = useState<"letta" | "companion">(saved?.preset === "companion" ? "companion" : "letta");
  // The personal part of the Companion prompt; the technical part is locked.
  const [personal, setPersonal] = useState(typeof saved?.personal === "string" ? saved.personal : COMPANION_PERSONAL);
  const [model, setModel] = useState<string | null>(typeof saved?.model === "string" ? saved.model : null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ draft, edits, step, preset, personal, model } satisfies Saved));
    } catch {
      // Not remembered between visits; the builder still works.
    }
  }, [draft, edits, step, preset, personal, model]);

  const generated = useMemo(() => companionFiles(draft), [draft]);
  const files = useMemo(() => generated.map((file) => ({ ...file, ...edits[file.label] })), [generated, edits]);
  const missing = missingFields(draft);
  const stepIndex = STEPS.findIndex((item) => item.id === step);
  const go = (next: Step) => {
    setError(null);
    setStep(next);
  };
  const change = (field: CompanionField, value: string) => setDraft((current) => ({ ...current, [field]: value }));
  const editFile = (label: CompanionFileLabel, patch: Partial<Pick<CompanionFile, "description" | "value">>) =>
    setEdits((current) => ({ ...current, [label]: { ...current[label], ...patch } }));

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      await createAgent({
        name: draft.agentName.trim(),
        ...(model && !needsProvider ? { model } : {}),
        ...companionCreation(files, preset, personal),
      });
      try {
        localStorage.removeItem(DRAFT_KEY);
      } catch {
        // Nothing to clear.
      }
      onClose();
    } catch (failure) {
      const message = describeCreateError(failure instanceof Error ? failure.message : String(failure));
      // The companion exists but a memory file couldn't be written: finish with
      // a notice rather than inviting a second, duplicate creation.
      if (/was created, but/.test(message)) {
        try {
          localStorage.removeItem(DRAFT_KEY);
        } catch {
          // Nothing to clear.
        }
        onClose();
        setNotice(message);
        return;
      }
      setError(message);
      setCreating(false);
    }
  };

  const questionStep = step === "ai" || step === "human" || step === "relationship" ? step : null;
  const stepMissing = questionStep ? missingFields(draft, STEP_FIELDS[questionStep]) : [];
  const notReady = files.filter((file) => (file.label !== "relationship" || fileHasContent(file)) && !fileIsReady(file));

  return (
    <div className="mt-4 grid min-h-0 flex-1 grid-rows-[auto_1fr_auto] gap-4">
      <nav aria-label="Companion steps" className="flex flex-wrap gap-1.5">
        {STEPS.map((item, index) => (
          <button
            key={item.id}
            type="button"
            onClick={() => go(item.id)}
            aria-current={step === item.id ? "step" : undefined}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors ${step === item.id ? "bg-accent-subtle font-medium text-ink-900" : "text-muted hover:bg-surface-tertiary hover:text-ink-800"}`}
          >
            <span className="tabular-nums">{index + 1}</span>
            {item.label}
          </button>
        ))}
      </nav>

      {/* A fresh scroll area per page, so each opens at its heading. */}
      <div key={step} className="min-h-0 overflow-y-auto pr-1">
        {questionStep && (
          <div className="grid gap-4">
            <div>
              <h3 className="text-base font-semibold text-ink-900">{HEADINGS[questionStep].title}</h3>
              <p className="text-sm text-muted">{HEADINGS[questionStep].text}</p>
            </div>
            {questionStep === "relationship" && (
              <div className="grid gap-1.5">
                <span className="text-sm font-medium text-ink-900">Relationship</span>
                <div role="group" aria-label="Relationship model" className="flex flex-wrap gap-1.5">
                  {RELATIONSHIP_TYPES.map((choice) => (
                    <button
                      key={choice}
                      type="button"
                      aria-pressed={draft.relationshipType === choice}
                      onClick={() => change("relationshipType", choice)}
                      className={`rounded-full border px-3 py-1 text-xs ${draft.relationshipType === choice ? "border-accent bg-accent-subtle text-ink-900" : "border-border text-ink-700 hover:bg-surface-tertiary"}`}
                    >
                      {choice}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {STEP_FIELDS[questionStep]
              .filter((field) => field !== "relationshipType" && !QUESTIONS[field].optional)
              .map((field) => (
                <Question key={field} field={field} draft={draft} onChange={change} />
              ))}
            <details className="group grid gap-4" open={STEP_FIELDS[questionStep].some((field) => QUESTIONS[field].optional && draft[field].trim() && draft[field] !== initialDraft[field])}>
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm text-accent">
                <ChevronRightIcon className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
                {HEADINGS[questionStep].more}
              </summary>
              <div className="mt-3 grid gap-4">
                {STEP_FIELDS[questionStep]
                  .filter((field) => QUESTIONS[field].optional)
                  .map((field) => (
                    <Question key={field} field={field} draft={draft} onChange={change} />
                  ))}
              </div>
            </details>
          </div>
        )}

        {step === "review" && (
          <div className="grid gap-3">
            <div>
              <h3 className="text-base font-semibold text-ink-900">Review the memory files.</h3>
              <p className="text-sm text-muted">These are core memory seeds. Letta chooses their storage paths for its memory format; the names below are labels, not fixed paths. Edit anything; they can also be changed later in Memory.</p>
            </div>
            <div role="tablist" aria-label="Memory files" className="flex gap-1">
              {files.map((file) => (
                <button
                  key={file.label}
                  type="button"
                  role="tab"
                  aria-selected={tab === file.label}
                  onClick={() => setTab(file.label)}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-mono text-xs ${tab === file.label ? "bg-surface-tertiary text-ink-900" : "text-muted hover:text-ink-800"}`}
                >
                  {fileIsReady(file) && <CheckIcon className="h-3 w-3 text-success" />}
                  {filePath(file.label)}
                </button>
              ))}
            </div>
            {files
              .filter((file) => file.label === tab)
              .map((file) => (
                <div key={file.label} className="grid gap-2">
                  <label className="grid gap-1">
                    <span className="text-xs font-medium text-ink-700">Description: when the agent should use this file</span>
                    <input aria-label={`${filePath(file.label)} description`} className="field" value={file.description} onChange={(event) => editFile(file.label, { description: event.target.value })} />
                  </label>
                  <textarea
                    aria-label={`${filePath(file.label)} content`}
                    rows={12}
                    spellCheck={false}
                    className="field resize-y font-mono text-[13px] leading-relaxed"
                    value={file.value}
                    onChange={(event) => editFile(file.label, { value: event.target.value })}
                  />
                  {edits[file.label]?.value !== undefined && (
                    <p className="text-xs text-muted">
                      Edited by you, so changing your answers won't overwrite it.{" "}
                      <button
                        type="button"
                        className="text-accent hover:underline"
                        onClick={() =>
                          setEdits((current) => {
                            const { value: _dropped, ...rest } = current[file.label] ?? {};
                            return { ...current, [file.label]: rest };
                          })
                        }
                      >
                        Rebuild it from your answers
                      </button>
                    </p>
                  )}
                </div>
              ))}
          </div>
        )}

        {step === "create" && (
          <div className="grid gap-4">
            <div>
              <h3 className="text-base font-semibold text-ink-900">Create {draft.agentName.trim() || "your companion"}.</h3>
              <p className="text-sm text-muted">Letta initialises the core memory you reviewed. Choose either its managed default prompt or Hearthside’s full custom Companion prompt.</p>
            </div>
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium text-ink-900">Companion foundation</legend>
              <label className={`flex cursor-pointer gap-3 rounded-xl border p-3 ${preset === "letta" ? "border-accent bg-accent-subtle" : "border-border"}`}>
                <input type="radio" name="preset" aria-label="Letta's default prompt" checked={preset === "letta"} onChange={() => setPreset("letta")} />
                <span>
                  <span className="block text-sm font-medium text-ink-900">Letta's default</span>
                  <span className="block text-xs text-muted">Keep Letta's standard instructions and use only the core memory you reviewed.</span>
                </span>
              </label>
              <label className={`flex cursor-pointer gap-3 rounded-xl border p-3 ${preset === "companion" ? "border-accent bg-accent-subtle" : "border-border"}`}>
                <input type="radio" name="preset" aria-label="Companion prompt" checked={preset === "companion"} onChange={() => setPreset("companion")} />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-ink-900">Companion</span>
                  <span className="block text-xs text-muted">Use the full Companion system prompt: your personal foundation plus Hearthside’s maintained technical instructions. Your reviewed memory stays separate.</span>
                </span>
              </label>
              {preset === "letta" && <LettaDefaultReference />}
              {preset === "companion" && (
                <div className="grid gap-2">
                  <label className="grid gap-1">
                    <span className="text-xs font-medium text-ink-700">Who they are as an agent (yours to edit)</span>
                    <textarea
                      aria-label="Companion prompt, personal part"
                      rows={8}
                      className="field resize-y text-xs leading-relaxed"
                      value={personal}
                      onChange={(event) => setPersonal(event.target.value)}
                    />
                    {personal.trim() !== COMPANION_PERSONAL && (
                      <button type="button" className="justify-self-start text-xs text-accent hover:underline" onClick={() => setPersonal(COMPANION_PERSONAL)}>
                        Put back Hearthside's wording
                      </button>
                    )}
                  </label>
                  <div className="grid gap-1">
                    <p className="text-xs text-muted">This custom prompt is not automatically upgraded by Letta. Technical updates require review and consent; your personal wording is preserved.</p>
                    <span className="text-xs font-medium text-muted">How memory, tools and Letta work (read-only)</span>
                    <pre aria-label="Companion prompt, technical part" tabIndex={0} className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-surface-tertiary p-3 text-xs leading-relaxed text-muted">{COMPANION_TECHNICAL}</pre>
                  </div>
                </div>
              )}
            </fieldset>
            {needsProvider ? (
              <div className="rounded-xl border border-border bg-surface-secondary px-3 py-2.5 text-xs text-ink-800">
                <span className="block font-medium text-ink-900">No model connected yet. That's fine.</span>
                {draft.agentName.trim() || "Your companion"} can be created now and get a model afterwards: a ChatGPT or Claude plan, an API key, or a
                local server like Ollama. Your answers are kept on this computer either way.
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
                <span className="text-sm font-medium text-ink-900">Model</span>
                <ModelPicker value={model} models={models} onChange={setModel} placement="top" />
                <span className="text-xs text-muted">You can switch models per chat later.</span>
              </div>
            )}
            {(missing.length > 0 || notReady.length > 0) && (
              <p className="rounded-xl bg-surface-secondary px-3 py-2 text-xs text-ink-800">
                {missing.length > 0
                  ? `Still needed: ${missing.map((field) => QUESTIONS[field].label.toLowerCase()).join(", ")}.`
                  : `Add a little more to ${notReady.map((file) => filePath(file.label)).join(", ")} (a description and some content).`}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="grid gap-2">
        {error && (
          <p role="alert" className="break-words text-xs text-error">
            {error}
          </p>
        )}
        {questionStep && stepMissing.length > 0 && (
          <p className="text-xs text-muted">Needed on this page: {stepMissing.map((field) => QUESTIONS[field].label.toLowerCase()).join(", ")}.</p>
        )}
        <div className="flex items-center justify-between gap-2">
          <button type="button" className="text-xs text-muted hover:text-ink-800 hover:underline" onClick={stepIndex === 0 ? onBack : () => go(STEPS[stepIndex - 1]!.id)} disabled={creating}>
            {stepIndex === 0 ? "← Other ways to start" : "← Back"}
          </button>
          <div className="flex gap-2">
            <button type="button" className="button-secondary" onClick={onClose} disabled={creating}>
              Close
            </button>
            {step !== "create" ? (
              <button type="button" className="button-primary" onClick={() => go(STEPS[stepIndex + 1]!.id)}>
                Next
              </button>
            ) : (
              <button type="button" className="button-primary" disabled={creating || missing.length > 0 || notReady.length > 0} onClick={() => void create()}>
                {creating && <Spinner className="h-3.5 w-3.5" />}
                {creating ? "Creating" : `Create ${draft.agentName.trim() || "companion"}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
