import type { DreamSettings } from "@hearthside/ipc-contract";
import { request } from "./control.js";

/**
 * Dreaming: the runtime's background reflection that reviews recent
 * conversations and updates the agent's memory. Settings are per agent and
 * stored by the runtime ("global" scope = keyed by agent in its settings).
 */

type Snapshot = { trigger: DreamSettings["trigger"]; step_count: number; merge: DreamSettings["merge"]; merge_instructions: string };
type Reply = { type: string; success?: boolean; error?: string; reflection_settings: Snapshot | null };

const DEFAULTS: DreamSettings = { trigger: "step-count", stepCount: 25, merge: "auto", mergeInstructions: "" };

function fromSnapshot(snapshot: Snapshot | null): DreamSettings {
  if (!snapshot) return DEFAULTS;
  return {
    trigger: snapshot.trigger,
    stepCount: snapshot.step_count,
    merge: snapshot.merge,
    mergeInstructions: snapshot.merge_instructions ?? "",
  };
}

const runtimeFor = (agentId: string) => ({ agent_id: agentId, conversation_id: "default" });

export async function getDreamSettings(agentId: string): Promise<DreamSettings> {
  const reply = await request<Reply>("get_reflection_settings", { runtime: runtimeFor(agentId) });
  return fromSnapshot(reply.reflection_settings);
}

export async function setDreamSettings(agentId: string, settings: DreamSettings): Promise<DreamSettings> {
  const reply = await request<Reply>("set_reflection_settings", {
    runtime: runtimeFor(agentId),
    scope: "global",
    settings: {
      trigger: settings.trigger,
      step_count: settings.stepCount,
      merge: settings.merge,
      merge_instructions: settings.mergeInstructions,
    },
  });
  return fromSnapshot(reply.reflection_settings);
}
