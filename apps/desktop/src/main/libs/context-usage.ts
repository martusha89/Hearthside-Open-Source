import type { ChatUsage } from "@hearthside/ipc-contract";

export function nonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Match the runtime's effective agent limit, not the model catalogue's maximum. */
export function effectiveContextWindow(agent: unknown): number | null {
  const value = agent as { context_window_limit?: unknown; llm_config?: { context_window?: unknown } };
  const limit = nonnegativeNumber(value.context_window_limit) ?? nonnegativeNumber(value.llm_config?.context_window);
  return limit && limit > 0 ? limit : null;
}

export function applyUsage(usage: ChatUsage, event: Record<string, unknown>): ChatUsage {
  return {
    ...usage,
    contextTokens: nonnegativeNumber(event.context_tokens) ?? usage.contextTokens,
    promptTokens: usage.promptTokens + (nonnegativeNumber(event.prompt_tokens) ?? 0),
    completionTokens: usage.completionTokens + (nonnegativeNumber(event.completion_tokens) ?? 0),
  };
}
