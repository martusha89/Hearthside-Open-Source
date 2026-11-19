// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { relativeToFolder, toolLabel, toolSummary } from "../lib/format";
import type { ApprovalDecision, ApprovalRequest } from "../types";
import { type Question, QuestionForm, primaryButton, secondaryButton } from "./QuestionForm";
import { ShieldIcon } from "./icons";

/** The agent wants to run a tool that needs the user's permission. */
/** The text a file-writing tool is about to put on disk, when it says. */
function proposedText(input: Record<string, unknown>): string | null {
  for (const key of ["content", "new_string"]) {
    const value = input[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

export function ApprovalPanel({
  request,
  queued,
  cwd,
  onDecide,
  sending = false,
  error = null,
}: {
  request: ApprovalRequest;
  /** Other approvals waiting behind this one. */
  queued: number;
  /** The chat's working folder, used to shorten paths. */
  cwd: string;
  onDecide: (decision: ApprovalDecision) => void;
  /** Hearthside: the answer is on its way (buttons off), or why it didn't arrive. */
  sending?: boolean;
  error?: string | null;
}) {
  const questions = (request.input as { questions?: Question[] }).questions;
  const isQuestion = request.toolName === "AskUserQuestion" && Array.isArray(questions);
  const summary = relativeToFolder(toolSummary(request.input), cwd);
  const proposed = proposedText(request.input);

  return (
    <div className="mx-auto max-h-[40vh] w-full max-w-3xl overflow-y-auto px-6 pb-3">
      {/* Keyed so a form never carries answers over to the next request. */}
      <div key={request.requestId} className="overflow-hidden rounded-[1.4rem] border border-border bg-surface-secondary shadow-elevated">
        {isQuestion ? (
          <div className="p-5">
            <QuestionForm
              questions={questions ?? []}
              onAnswer={(answers) => onDecide({ behavior: "allow", updatedInput: { ...request.input, answers } })}
              onSkip={() => onDecide({ behavior: "deny", message: "The user skipped the question." })}
            />
          </div>
        ) : (
          <div className="p-5">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-light text-accent">
                <ShieldIcon className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Permission</p>
                <p className="mt-0.5 text-base font-semibold text-ink-900">
                  Allow {toolLabel(request.toolName)}?
                </p>
                <p className="mt-1 text-xs leading-5 text-muted">This request is waiting for your decision.</p>
              </div>
              {queued > 0 && <span className="shrink-0 rounded-full bg-surface-tertiary px-2.5 py-1 text-xs text-muted">{queued} more waiting</span>}
            </div>
            <p className="mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Request preview</p>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-surface p-3 font-mono text-xs leading-5 text-ink-800">
              {summary || JSON.stringify(request.input, null, 2)}
            </pre>
            {proposed && (
              <div className="mt-3">
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Proposed content</p>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-surface p-3 font-mono text-xs leading-5 text-ink-700">
                  {proposed}
                </pre>
              </div>
            )}
            {/* The line above is one field of the request, picked for brevity. What is being
                approved is all of it (a helper's full instructions, every edit, a request's body). */}
            {summary && Object.keys(request.input).length > 1 && (
              <details className="mt-2 text-xs text-muted">
                <summary className="cursor-pointer select-none hover:text-ink-700">Show everything this would be given</summary>
                <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border p-3 font-mono text-xs text-ink-700">
                  {JSON.stringify(request.input, null, 2)}
                </pre>
              </details>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                className={primaryButton}
                disabled={sending}
                onClick={() => onDecide({ behavior: "allow" })}
              >
                Allow
              </button>
              {request.suggestions.map((suggestion) => (
                <button
                  key={suggestion.id}
                  type="button"
                  className={secondaryButton}
                  disabled={sending}
                  title={suggestion.text}
                  onClick={() => onDecide({ behavior: "allow", suggestionIds: [suggestion.id] })}
                >
                  <span className="block max-w-[26rem] truncate">{suggestion.text}</span>
                </button>
              ))}
              <button
                type="button"
                className={secondaryButton}
                disabled={sending}
                onClick={() => onDecide({ behavior: "deny" })}
              >
                Deny
              </button>
            </div>
          </div>
        )}
        {error && <p className="border-t border-error/20 bg-error-light px-5 py-2.5 text-xs text-error">{error}</p>}
      </div>
    </div>
  );
}
