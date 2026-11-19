import type { ModelSource } from "@hearthside/ipc-contract";




export type ProviderInfo = { name: string; type: string; category: string };

const PROVIDERS: Record<string, string> = {
  openai: "OpenAI", anthropic: "Anthropic", google_ai: "Google", google_vertex: "Google Vertex", gemini: "Google",
  bedrock: "Amazon Bedrock", openrouter: "OpenRouter", groq: "Groq", xai: "xAI", together: "Together",
  minimax: "MiniMax", deepseek: "DeepSeek", ollama: "Ollama", mistral: "Mistral", azure: "Azure",
  lmstudio: "LM Studio", "lmstudio_openai": "LM Studio", vllm: "vLLM", cerebras: "Cerebras", fireworks: "Fireworks",
  zai: "Z.ai", "z-ai": "Z.ai", moonshot: "Moonshot", moonshotai: "Moonshot", letta: "Letta", meta: "Meta",
};

/** Sign-in plans rather than keys, by the provider name Letta gives them. */
const PLANS: Record<string, string> = {
  "chatgpt-plus-pro": "Your ChatGPT plan",
  "claude-subscription": "Your Claude plan",
  "lc-xai": "Your xAI / X subscription",
  "openrouter-oauth": "Your OpenRouter account",
};
const PLAN_TYPES: Record<string, string> = { chatgpt_oauth: "Your ChatGPT plan", anthropic_oauth: "Your Claude plan" };

const pretty = (id: string) => PROVIDERS[id] ?? PROVIDERS[id.toLowerCase()] ?? id;

export function modelSource(handle: string, backend: "cloud" | "local" | "remote", info?: ProviderInfo): ModelSource {
  const slash = handle.indexOf("/");
  const prefix = slash > 0 ? handle.slice(0, slash) : "";
  const model = slash > 0 ? handle.slice(slash + 1) : handle;

  if (prefix === "letta") {
    return model.startsWith("auto")
      ? { kind: "letta", label: "Letta picks the model for each message · Letta credits" }
      : { kind: "letta", label: "Letta's own model · Letta credits" };
  }
  const plan = PLANS[info?.name ?? prefix] ?? (info ? PLAN_TYPES[info.type] : undefined);
  if (plan) return { kind: "plan", label: plan };

  if (backend === "cloud") {
    if (info?.category === "byok") return { kind: "key", label: `Your ${pretty(info.type)} key · "${info.name}"` };
    if (info?.category === "base") {
      const via = info.type === "openrouter" && prefix !== "openrouter" ? `${pretty(prefix)} through OpenRouter` : pretty(info.type);
      return { kind: "hosted", label: `${via}, hosted by Letta · Letta credits` };
    }
    // Letta didn't describe this provider: say only what the handle shows.
    return { kind: "unknown", label: `Provider "${prefix || "unknown"}"` };
  }
  if (backend === "remote") return { kind: "server", label: `Your Letta server · ${pretty(prefix || "unknown")}` };
  return { kind: "key", label: `Your ${pretty(prefix || "unknown")} connection on this computer` };
}
