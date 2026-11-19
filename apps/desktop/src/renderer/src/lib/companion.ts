// Hearthside: the companion builder's model, ported from Continuity Studio
// (https://github.com/martusha89/continuity-studio, Apache-2.0: src/domain.ts,
// src/generate.ts, src/memory-review.ts). Core memory is seeded through the
// SDK; the installed runtime owns physical paths, headers, and indexing.

import { composeCompanionPrompt } from "./companion-prompt";

/** The builder's payload, shared with boundary tests for both runtime backends. */
export function companionCreation(files: CompanionFile[], preset: "letta" | "companion", personal: string) {
  return {
    coreMemory: memorySeeds(files),
    ...(preset === "companion" ? { systemPrompt: composeCompanionPrompt(personal) } : {}),
  };
}

export interface CompanionDraft {
  agentName: string;
  identity: string;
  temperament: string;
  voice: string;
  values: string;
  boundaries: string;
  autonomy: string;
  humanName: string;
  humanContext: string;
  communication: string;
  support: string;
  avoid: string;
  relationshipType: string;
  relationshipFoundation: string;
  decisionMaking: string;
  continuity: string;
}

export type CompanionField = keyof CompanionDraft;
export type CompanionFileLabel = "persona" | "human" | "relationship";

export interface CompanionFile {
  label: CompanionFileLabel;
  description: string;
  value: string;
}

export const RELATIONSHIP_TYPES = ["Personal companion", "Creative partner", "Coach", "Research collaborator", "Assistant", "Custom"] as const;

export const initialDraft: CompanionDraft = {
  agentName: "",
  identity: "",
  temperament: "",
  voice: "",
  values: "",
  boundaries: "",
  autonomy: "",
  humanName: "",
  humanContext: "",
  communication: "",
  support: "",
  avoid: "",
  relationshipType: "Personal companion",
  relationshipFoundation: "",
  decisionMaking: "",
  continuity: "Use saved memory and retrievable history as context. Never invent a shared past or pretend an interruption did not happen.",
};

/** Each question: where it goes, its label, hint and example (Continuity Studio's wording). */
export const QUESTIONS: Record<CompanionField, { label: string; hint: string; placeholder: string; optional?: boolean; short?: boolean }> = {
  agentName: { label: "Name", hint: "What should they call themselves?", placeholder: "e.g. Rowan", short: true },
  identity: { label: "Identity", hint: "Background, role, sense of self, and what makes them recognisable.", placeholder: "They are…" },
  voice: { label: "Voice", hint: "Rhythm, directness, humour, warmth, vocabulary.", placeholder: "Direct without becoming cold…", optional: true },
  temperament: { label: "Temperament", hint: "How they meet the world when no explicit tone is requested.", placeholder: "Steady, curious, irreverent…", optional: true },
  values: { label: "Values", hint: "What they protect and what wins when values collide.", placeholder: "Truth before comfort…", optional: true },
  boundaries: { label: "Boundaries", hint: "Hard limits, refusals, and things they must never pretend.", placeholder: "Never fabricate a memory…", optional: true },
  autonomy: { label: "Agency", hint: "How much initiative, disagreement, and independent judgment should they use?", placeholder: "Take the next safe move without asking…", optional: true },
  humanName: { label: "Your name", hint: "The name they should know you by.", placeholder: "e.g. Alex", short: true },
  humanContext: { label: "Context", hint: "Life, work, motivations, accessibility, and durable circumstances.", placeholder: "Alex is building…" },
  communication: { label: "Communication", hint: "Detail, tone, corrections, humour, and how to handle uncertainty.", placeholder: "Lead with the answer…", optional: true },
  support: { label: "Good support", hint: "What genuinely useful presence or collaboration looks like.", placeholder: "When overwhelmed, reduce the world to…", optional: true },
  avoid: { label: "Avoid", hint: "Patterns, phrases, or assumptions that create friction or harm.", placeholder: "Do not turn every raw moment into a plan…", optional: true },
  relationshipType: { label: "Relationship", hint: "What kind of relationship this is.", placeholder: "" },
  relationshipFoundation: { label: "Foundation", hint: "Equality, authority, care, trust, and the purpose of the relationship.", placeholder: "They are partners and equals…", optional: true },
  decisionMaking: { label: "Decision-making", hint: "When should they lead, ask, disagree, or stop?", placeholder: "Take initiative when consequences are reversible…", optional: true },
  continuity: { label: "Continuity", hint: "What should persist across conversations, models, devices, and gaps?", placeholder: "Infrastructure can change without erasing…", optional: true },
};

export const STEP_FIELDS: Record<"ai" | "human" | "relationship", CompanionField[]> = {
  ai: ["agentName", "identity", "voice", "temperament", "values", "boundaries", "autonomy"],
  human: ["humanName", "humanContext", "communication", "support", "avoid"],
  relationship: ["relationshipType", "relationshipFoundation", "decisionMaking", "continuity"],
};

export const REQUIRED_FIELDS: CompanionField[] = ["agentName", "identity", "humanName", "humanContext"];

export const FILE_FOR_FIELD: Record<CompanionField, CompanionFileLabel> = {
  agentName: "persona",
  identity: "persona",
  temperament: "persona",
  voice: "persona",
  values: "persona",
  boundaries: "persona",
  autonomy: "persona",
  humanName: "human",
  humanContext: "human",
  communication: "human",
  support: "human",
  avoid: "human",
  relationshipType: "relationship",
  relationshipFoundation: "relationship",
  decisionMaking: "relationship",
  continuity: "relationship",
};

export function missingFields(draft: CompanionDraft, fields: CompanionField[] = REQUIRED_FIELDS): CompanionField[] {
  return fields.filter((field) => REQUIRED_FIELDS.includes(field) && draft[field].trim().length === 0);
}

const section = (title: string, value: string) => (value.trim() ? `## ${title}\n\n${value.trim()}` : "");
const joinSections = (...sections: string[]) => sections.filter(Boolean).join("\n\n");

/** The three memory files, from the answers (Continuity Studio's generateLettaPreview). */
export function companionFiles(draft: CompanionDraft): CompanionFile[] {
  const name = draft.agentName.trim() || "Your companion";
  const humanName = draft.humanName.trim() || "The human";
  const files: CompanionFile[] = [
    {
      label: "persona",
      description: "Who the agent is, what they value, and how they communicate.",
      value: joinSections(
        `# ${name}`,
        section("Identity", draft.identity),
        section("Temperament", draft.temperament),
        section("Voice", draft.voice),
        section("Values", draft.values),
        section("Boundaries", draft.boundaries),
        section("Agency and initiative", draft.autonomy),
      ),
    },
    {
      label: "human",
      description: "Persistent context about the human and how to support them.",
      value: joinSections(
        `# ${humanName}`,
        section("Context", draft.humanContext),
        section("Communication", draft.communication),
        section("What good support looks like", draft.support),
        section("Avoid", draft.avoid),
      ),
    },
    {
      label: "relationship",
      description: "The authority, trust, decisions, and continuity rules for this relationship.",
      value: joinSections(
        "# Relationship and collaboration",
        section("Model", draft.relationshipType),
        section("Foundation", draft.relationshipFoundation),
        section("Decision-making", draft.decisionMaking),
        section("Continuity", draft.continuity),
      ),
    },
  ];
  return files.filter(fileHasContent);
}

/** Headings alone are placeholders, not durable memory. */
export function fileHasContent(file: CompanionFile): boolean {
  return file.value.replace(/^#{1,6}[ \t]+.*$/gm, "").trim().length > 0;
}

/** Short real answers are valid; no arbitrary minimum length is required. */
export function fileIsReady(file: CompanionFile): boolean {
  return file.description.trim().length > 0 && fileHasContent(file);
}

/** Review display name only; the SDK chooses the actual core-memory path. */
export const filePath = (label: CompanionFileLabel) => `${label}.md`;

/** Seed core memory through the SDK without assuming a filesystem layout. */
export function memorySeeds(files: CompanionFile[]): CompanionFile[] {
  return files.filter(fileHasContent).map((file) => ({
    label: file.label,
    description: file.description,
    value: file.value,
  }));
}
