import { type NativeTeleportReceipt, parseNativeTeleportResponse, validateNativeTeleportStatus } from "./native-teleport";

/** How Letta scopes a conversation: "default" stands in for a main chat. */
export type TeleportScope = { agentId: string; conversationId: string };

/** The two calls the native control plane needs, injected so tests never reach the network. */
export type TeleportTransport = {
  post(path: string, body: Record<string, unknown>): Promise<unknown>;
  get(path: string): Promise<unknown>;
};

/**
 * The outcome of asking for a move.
 *
 * `refused` and `unknown` are kept apart on purpose. A refusal is proof that
 * nothing started, so the conversation is still on its source and the person
 * can be told why. An unknown outcome is the opposite of proof: the move may
 * be running. Collapsing the two would let the app claim a conversation is
 * still here while it is being handed to another computer.
 */
export type TeleportRequestOutcome =
  | { outcome: "accepted"; receipt: NativeTeleportReceipt }
  | { outcome: "refused"; reason: string }
  | { outcome: "unknown"; reason: string };

function teleportPath(scope: TeleportScope, suffix = ""): string {
  return `/v1/environments/runtimes/${encodeURIComponent(scope.agentId)}/${encodeURIComponent(scope.conversationId)}/teleport${suffix}`;
}

function record(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

/** Letta's clients surface the HTTP status under more than one name. */
function statusOf(error: unknown): number | null {
  if (!record(error)) return null;
  for (const key of ["statusCode", "status", "httpStatus"]) {
    const value = error[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return null;
}

function reasonOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (record(error) && typeof error.message === "string" && error.message.trim()) return error.message.trim();
  return fallback;
}

/**
 * Ask Letta to move a conversation to `targetConnectionId`.
 *
 * `idempotencyKey` is the caller's, persisted before this is ever called. It is
 * never generated here, so a retry of an unresolved move reuses the original
 * key and can only reconcile that move rather than start another one.
 *
 * A successful response is **acceptance, not completion**: the returned receipt
 * says the move was admitted, and its status still has to be read.
 */
export async function requestNativeTeleport(
  transport: TeleportTransport,
  scope: TeleportScope,
  targetConnectionId: string,
  idempotencyKey: string,
): Promise<TeleportRequestOutcome> {
  let raw: unknown;
  try {
    raw = await transport.post(teleportPath(scope), { targetConnectionId, idempotencyKey });
  } catch (error) {
    const status = statusOf(error);
    // A refusal Letta states deliberately (bad target, channel-bound
    // conversation, a move already pending) means nothing was started. Anything
    // else — a timeout, a dropped socket, a server fault — leaves the request's
    // fate unknown, because the move may have been admitted before the failure.
    if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) {
      return { outcome: "refused", reason: reasonOf(error, "Letta refused the move.") };
    }
    return { outcome: "unknown", reason: reasonOf(error, "The move request did not come back.") };
  }
  const receipt = readTeleportResponse(raw, scope, targetConnectionId);
  if (!receipt) {
    // The request was answered, so it was very likely admitted; the answer just
    // was not one this build can read. Treating that as a refusal would strand
    // a move that is already under way.
    return { outcome: "unknown", reason: "Letta accepted the move but its reply could not be read." };
  }
  return { outcome: "accepted", receipt };
}

/**
 * Validate a teleport response against the scope and target it was asked for.
 *
 * Exported for the acceptance path only; status reads go through
 * `readNativeTeleportStatus`, which additionally pins every identity field.
 */
export function readTeleportResponse(raw: unknown, scope: TeleportScope, targetConnectionId: string): NativeTeleportReceipt | null {
  const receipt = parseNativeTeleportResponse(raw);
  if (!receipt) return null;
  if (receipt.agentId !== scope.agentId || receipt.conversationId !== scope.conversationId) return null;
  if (receipt.targetConnectionId !== targetConnectionId) return null;
  return receipt;
}

/**
 * Read the authoritative status of an accepted move.
 *
 * Returns null when the answer cannot be trusted — unreadable, or naming a
 * different move. Null means "no new information", never "the move failed":
 * the caller keeps whatever it already believed.
 */
export async function readNativeTeleportStatus(
  transport: TeleportTransport,
  scope: TeleportScope,
  accepted: NativeTeleportReceipt,
): Promise<NativeTeleportReceipt | null> {
  let raw: unknown;
  try {
    raw = await transport.get(teleportPath(scope, `s/${encodeURIComponent(accepted.id)}`));
  } catch {
    return null;
  }
  return validateNativeTeleportStatus(raw, accepted);
}

/** Map a native status onto the move phase. Attachment phases are the caller's. */
export function phaseForStatus(status: NativeTeleportReceipt["status"]): "waiting-source" | "starting" | "connecting" | "failed" {
  switch (status) {
    case "waiting_for_source": return "waiting-source";
    case "starting_destination": return "starting";
    case "completed": return "connecting";
    case "failed": return "failed";
  }
}
