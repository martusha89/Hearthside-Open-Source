// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { useState } from "react";

export type Question = {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
};

export const primaryButton =
  "rounded-full bg-accent px-4 py-1.5 text-sm font-medium text-brand-content transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40";
export const secondaryButton =
  "rounded-full border border-border bg-surface px-4 py-1.5 text-sm font-medium text-ink-800 hover:bg-surface-tertiary transition-colors";

/** Questions from the agent: pick options, or type an answer of your own. */
export function QuestionForm({
  questions,
  onAnswer,
  onSkip,
}: {
  questions: Question[];
  /** Answers keyed by the question text. */
  onAnswer: (answers: Record<string, string>) => void;
  onSkip: () => void;
}) {
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});

  const answerFor = (index: number) => other[index]?.trim() || (selected[index] ?? []).join(", ");
  const complete = questions.every((_, index) => answerFor(index).length > 0);

  const toggle = (index: number, question: Question, label: string) => {
    // A lone single-choice question is answered by the click itself.
    if (questions.length === 1 && !question.multiSelect) {
      onAnswer({ [question.question]: label });
      return;
    }
    setSelected((previous) => {
      const current = previous[index] ?? [];
      const next = question.multiSelect
        ? current.includes(label)
          ? current.filter((item) => item !== label)
          : [...current, label]
        : [label];
      return { ...previous, [index]: next };
    });
  };

  return (
    <div className="grid gap-4">
      {questions.map((question, index) => (
        <div key={index}>
          {question.header && <p className="text-xs font-medium uppercase tracking-wide text-muted">{question.header}</p>}
          <p className="text-sm font-medium text-ink-900">{question.question}</p>
          {question.multiSelect && <p className="mt-0.5 text-xs text-muted">Choose any that apply.</p>}
          <div className="mt-2 grid gap-1.5">
            {(question.options ?? []).map((option) => {
              const isSelected = (selected[index] ?? []).includes(option.label);
              return (
                <button
                  key={option.label}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => toggle(index, question, option.label)}
                  className={`rounded-xl border px-3 py-2 text-left text-sm transition-colors ${isSelected ? "border-accent bg-accent-subtle" : "border-border bg-surface hover:bg-surface-tertiary"}`}
                >
                  <span className="font-medium text-ink-900">{option.label}</span>
                  {option.description && <span className="mt-0.5 block text-xs text-muted">{option.description}</span>}
                </button>
              );
            })}
          </div>
          <input
            type="text"
            value={other[index] ?? ""}
            onChange={(event) => setOther((previous) => ({ ...previous, [index]: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && complete) onAnswer(Object.fromEntries(questions.map((q, i) => [q.question, answerFor(i)])));
            }}
            placeholder="Or type your own answer"
            aria-label={`Your own answer to: ${question.question}`}
            className="mt-2 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-ink-900 placeholder:text-muted focus:border-border-hover focus:outline-none"
          />
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!complete}
          className={primaryButton}
          onClick={() => onAnswer(Object.fromEntries(questions.map((q, index) => [q.question, answerFor(index)])))}
        >
          Send answer
        </button>
        <button type="button" className={secondaryButton} onClick={onSkip}>
          Skip
        </button>
      </div>
    </div>
  );
}
