import type { ModelOption, ReasoningEffort } from "../types";

// A chat's model is stored as one string: either a catalog id for a specific
// reasoning tier ("gpt-5.5-high") or a plain handle ("openai-codex/gpt-5.5",
// as agents report it). These helpers map between that string and the
// grouped model list the pickers show.

export const EFFORT_LABELS: Record<string, string> = {
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function effortLabel(effort: string): string {
  // Own properties only: the runtime's catalog names these levels, and a name
  // like "constructor" or "toString" would otherwise read a function off
  // Object's prototype and show it as the label.
  const known = Object.hasOwn(EFFORT_LABELS, effort) ? EFFORT_LABELS[effort] : undefined;
  return known ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** The model a stored value points at, and its reasoning tier if it names one. */
export function resolveModel(
  value: string | null,
  models: readonly ModelOption[],
): { model: ModelOption; effort: string | null } | null {
  if (!value) return null;
  for (const model of models) {
    const tier = model.reasoning.find((item) => item.id === value);
    if (tier) return { model, effort: tier.effort };
  }
  const model = models.find((item) => item.id === value || item.handle === value);
  if (!model) {
    // Agents can report a model under a provider alias ("chatgpt-plus-pro/gpt-5.5")
    // or bare ("gpt-5.5"). Match on the model name when that is unambiguous.
    const name = value.split("/").pop();
    const byName = models.filter((item) => item.handle.split("/").pop() === name);
    return byName.length === 1 && byName[0] ? { model: byName[0], effort: null } : null;
  }
  const tier = model.reasoning.find((item) => item.id === model.id);
  // A plain handle doesn't pin a tier: the runtime uses the model's default.
  return { model, effort: value === model.handle ? null : (tier?.effort ?? null) };
}

// The levels a Letta session takes (REASONING_EFFORTS in the ipc contract).
// Written out so the renderer needn't load the contract's code: the keys are
// checked against the type, so the two cannot drift apart.
const SESSION_EFFORTS: Record<ReasoningEffort, true> = { none: true, minimal: true, low: true, medium: true, high: true, xhigh: true };

// Own properties only: `in` would also accept "constructor", "toString" and
// the rest of Object's prototype, which are not levels. A provider tier named
// one of those must pass through untouched, not be sent as a reasoning level.
const isSessionEffort = (effort: string): effort is ReasoningEffort => Object.hasOwn(SESSION_EFFORTS, effort);

/**
 * What to send for a chosen catalog value. Letta takes a model handle and a
 * reasoning level as two separate things, so a value naming a tier
 * ("gpt-5.5-high") is split into both here — sending such an id as the model
 * leaves the level to the catalog, and a tier the catalog has since dropped
 * would quietly answer at the model's default.
 *
 * A value this catalog doesn't know goes through untouched, as does a tier
 * whose level isn't one a session takes (a provider's own name for it): those
 * ids are the provider's to resolve, as they were before.
 */
export function sessionModel(value: string, models: readonly ModelOption[]): { model: string; reasoningEffort?: ReasoningEffort } {
  for (const model of models) {
    const tier = model.reasoning.find((item) => item.id === value);
    if (!tier) continue;
    return isSessionEffort(tier.effort) ? { model: model.handle, reasoningEffort: tier.effort } : { model: value };
  }
  return { model: value };
}

/**
 * Menu-only normalization: aliases of a session-supported effort send the same
 * handle and effort. Provider-owned levels instead send their catalog id, so
 * matching labels/efforts alone do not prove those choices interchangeable.
 * Keep the raw catalog for exact alias lookup, defaults and session routing.
 */
export function reasoningOptions(model: ModelOption, selectedValue: string | null = null): ModelOption["reasoning"] {
  const options = new Map<string, ModelOption["reasoning"][number]>();
  for (const tier of model.reasoning) {
    const key = isSessionEffort(tier.effort) ? `effort:${tier.effort}` : `id:${tier.id}`;
    if (!options.has(key) || tier.id === selectedValue) options.set(key, tier);
  }
  return [...options.values()];
}

/**
 * What the reasoning chip reads, and which of the model's tiers it ticks. A
 * level is only ever claimed when one is known: unknown reads "Reasoning" and
 * ticks nothing, rather than standing in the model's default — the chip is
 * what the next message is sent with, so a stood-in level would be sent too.
 * A known level this catalog has no tier for is still shown, and still ticks
 * nothing: Letta holds it whether or not the catalog lists it.
 */
export function reasoningChoice(model: ModelOption, effort: string | null, selectedValue: string | null = null): { label: string; tickedTierId: string | null } {
  const options = reasoningOptions(model, selectedValue);
  const selected = options.find((tier) => tier.id === selectedValue && tier.effort === effort);
  return {
    label: effort ? effortLabel(effort) : "Reasoning",
    tickedTierId: selected?.id ?? (effort ? options.find((tier) => tier.effort === effort)?.id : null) ?? null,
  };
}

/** Value to store when picking `model`, keeping the current reasoning tier when the new model has it. */
export function valueForModel(model: ModelOption, currentEffort: string | null): string {
  const keep = currentEffort ? model.reasoning.find((tier) => tier.effort === currentEffort) : undefined;
  return keep?.id ?? model.id;
}

/** Value to store when picking a reasoning tier for `model`. */
export function valueForEffort(model: ModelOption, effort: string): string {
  return model.reasoning.find((tier) => tier.effort === effort)?.id ?? model.id;
}

/** Hearthside: a creation error in plain words ("Unknown model: x" is the runtime not knowing a tier id at creation). */
export function describeCreateError(message: string): string {
  const plain = message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
  if (/unknown model/i.test(plain)) {
    const which = /unknown model:\s*(\S+)/i.exec(plain)?.[1];
    return `${which ? `The model ${which}` : "That model"} wasn't accepted when creating the agent. Leave the model on Default and pick it in the chat afterwards, or check its provider in Settings → Providers.`;
  }
  return plain;
}
