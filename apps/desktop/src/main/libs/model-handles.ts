import type { ModelOption } from "@hearthside/ipc-contract";

/**
 * Hearthside: the model picker hands over a catalog entry id, which names a
 * reasoning tier ("gpt-5.6-sol-plus-pro-medium"). Chats apply such ids as
 * their model override, but creating an agent only resolves the ids of the
 * runtime's built-in catalog, not those a connected provider (a ChatGPT plan)
 * adds, and fails with "Unknown model". A handle ("provider/model") is always
 * accepted, so creation uses the handle; the tier is chosen per chat.
 */
export function handleForModel(models: readonly ModelOption[], id: string): string | null {
  if (id.includes("/")) return id;
  const model = models.find((option) => option.id === id || option.handle === id || option.reasoning.some((tier) => tier.id === id));
  return model?.handle ?? null;
}

/**
 * Hearthside: what to store as an agent's default model for a picker value.
 *
 * The picker's value is a catalog id that names a reasoning tier
 * ("gpt-5.5-medium"). The local store keeps whatever string it is given as the
 * model, so saving that id left the agent on a model no provider has: every
 * new chat failed with "Unknown model", while the picker (which resolves the id
 * back) went on showing the right name. A local default is therefore the
 * handle, with the level beside it in the model settings, where the runtime
 * reads it. Null when the value names nothing in the catalog.
 */
export function agentDefaultFor(models: readonly ModelOption[], value: string): { model: string; effort: string | null } | null {
  for (const model of models) {
    const tier = model.reasoning.find((item) => item.id === value);
    if (tier) return { model: model.handle, effort: tier.effort };
  }
  const model = models.find((option) => option.id === value || option.handle === value);
  if (model) return { model: model.handle, effort: null };
  return value.includes("/") ? { model: value, effort: null } : null;
}

/**
 * Hearthside: the model a local agent should be moved to, or null to leave it.
 *
 * The local runtime gives an agent created without a model its own built-in
 * default, whether or not that provider is connected, so a companion made
 * before (or beside) the person's provider could never answer. Only an agent
 * whose model nothing connected can serve is moved, and only when something
 * is connected to move it to.
 *
 * It is moved to the model the person last used, when that is still connected:
 * the first model in a provider's list is its largest, which is a costly thing
 * to pick for someone on a pay-per-token key who had been using a smaller one.
 * `lastUsed` is whatever was recorded (a handle or a picker's tier id). With
 * nothing recorded, or that model gone, the first connected model is used.
 */
export function modelToAdopt(models: readonly ModelOption[], current: string | null, lastUsed: string | null = null): string | null {
  const first = models[0];
  if (!first) return null;
  if (current && models.some((model) => model.handle === current)) return null;
  const preferred = lastUsed ? agentDefaultFor(models, lastUsed)?.model : null;
  return preferred && models.some((model) => model.handle === preferred) ? preferred : first.handle;
}
