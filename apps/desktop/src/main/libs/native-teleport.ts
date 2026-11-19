export type NativeTeleportReceipt = {
  id: string;
  agentId: string;
  conversationId: string;
  sourceConnectionId: string;
  targetConnectionId: string;
  targetDeviceId: string;
  targetConnectionName: string;
  status: "waiting_for_source" | "starting_destination" | "completed" | "failed";
  error: string | null;
};

const identityKeys = [
  "id", "agentId", "conversationId", "sourceConnectionId", "targetConnectionId",
  "targetDeviceId", "targetConnectionName",
] as const;

function record(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function receipt(raw: unknown): NativeTeleportReceipt | null {
  if (!record(raw)) return null;
  if (!identityKeys.every((key) => typeof raw[key] === "string" && raw[key].trim().length > 0)) return null;
  if (raw.status !== "waiting_for_source" && raw.status !== "starting_destination"
    && raw.status !== "completed" && raw.status !== "failed") return null;
  if (raw.error !== null && typeof raw.error !== "string") return null;
  // Copy only the validated fields; CLI timestamps and any extra fields are not trusted.
  return {
    id: raw.id as string,
    agentId: raw.agentId as string,
    conversationId: raw.conversationId as string,
    sourceConnectionId: raw.sourceConnectionId as string,
    targetConnectionId: raw.targetConnectionId as string,
    targetDeviceId: raw.targetDeviceId as string,
    targetConnectionName: raw.targetConnectionName as string,
    status: raw.status,
    error: raw.error,
  };
}

/** Validate a teleport receipt on its own, with no accepted receipt to pin it against. */
export function parseNativeTeleportResponse(raw: unknown): NativeTeleportReceipt | null {
  return receipt(raw);
}

/** Untrusted tool-output hint only. Read authoritative GET status before treating it as movement. */
export function parseNativeTeleportReceipt(
  content: string,
  scope: { agentId: string; conversationId: string },
  sourceConnectionId?: string,
): NativeTeleportReceipt | null {
  try {
    let raw: unknown = JSON.parse(content);
    // The CLI prints a complete JSON receipt; Bash may wrap that JSON in stdout.
    if (record(raw) && typeof raw.stdout === "string") raw = JSON.parse(raw.stdout);
    const parsed = receipt(raw);
    if (!parsed || parsed.agentId !== scope.agentId || parsed.conversationId !== scope.conversationId) return null;
    if (sourceConnectionId !== undefined && parsed.sourceConnectionId !== sourceConnectionId) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Validate an authoritative GET response against every identity in the accepted hint. */
export function validateNativeTeleportStatus(raw: unknown, accepted: NativeTeleportReceipt): NativeTeleportReceipt | null {
  const parsed = receipt(raw);
  if (!parsed || !receipt(accepted)) return null;
  return identityKeys.every((key) => parsed[key] === accepted[key]) ? parsed : null;
}
