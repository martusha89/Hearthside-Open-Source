// Derived from OSS-UI (https://github.com/letta-ai/letta-oss-ui, Apache-2.0, commit c01d155), modified by Hearthside.
import { createAppServerClient, type AppServerClient } from "@letta-ai/letta-code/app-server-client";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@hearthside/ipc-contract";
import WebSocket from "ws";
import { observeRuntimeIdle } from "./runtime-idle";

/**
 * A direct connection to the Letta app server for the parts of its protocol
 * the SDK does not wrap yet: model provider setup and agent memory files.
 *
 * It runs beside the SDK client, on the same server. The connection opens on
 * first use and reopens if it drops.
 */

export type ControlTarget = { url: string; authToken?: string };

type Reply = { type: string; request_id?: string; success?: boolean; error?: string };

let target: ControlTarget | null = null;
// Hearthside: push frames from the runtime (memory_updated) for the window.
let pushListener: ((message: { type: string } & Record<string, unknown>) => void) | null = null;

export function onControlPush(listener: typeof pushListener): void {
  pushListener = listener;
}
let connection: Promise<AppServerClient> | null = null;

/**
 * Hearthside: every protocol frame the runtime sends, for the parts of the
 * protocol that are not request-and-reply — a mod command's lifecycle end, and
 * the approval requests of a turn the listener is running rather than the SDK.
 *
 * Observers are per-connection: they are dropped when the connection is
 * re-pointed, so nothing carries over to another runtime.
 */
type FrameObserver = (frame: { type?: unknown } & Record<string, unknown>) => void;
const frameObservers = new Set<FrameObserver>();

export function observeControlFrames(observer: FrameObserver): () => void {
  frameObservers.add(observer);
  return () => frameObservers.delete(observer);
}

/**
 * Hearthside: which runtime the control connection points at, as a number that
 * changes every time it is re-pointed.
 *
 * Work that spans several awaits — admitting and sending a mod command, then
 * following the reply it started — has to belong to one runtime. Without this
 * a command admitted against one account could be sent to the next one, and a
 * ten-minute follower could keep polling a new account for an old chat.
 */
let generation = 0;
export function controlGeneration(): number {
  return generation;
}

export function setControlTarget(next: ControlTarget | null): void {
  const previous = connection;
  target = next;
  connection = null;
  generation += 1;
  // Observers belong to the connection they were registered on; none of them
  // carries over to another runtime.
  frameObservers.clear();
  void previous?.then((client) => client.close()).catch(() => undefined);
}


function connect(): Promise<AppServerClient> {
  if (!target) return Promise.reject(new Error("Not connected to Letta."));
  if (connection) return connection;

  // `ws` (not Node's built-in WebSocket) so the capability token can be sent as a header.
  const opening: Promise<AppServerClient> = createAppServerClient({ ...target, WebSocket: WebSocket as never })
    .connect()
    .then((client) => {
      client.onMessage((message) => {
        const frame = message as unknown as { type?: unknown } & Record<string, unknown>;
        if (frame?.type === "memory_updated") pushListener?.(message as never);
        if (!frame || typeof frame.type !== "string") return;
        for (const observer of [...frameObservers]) {
          try {
            observer(frame);
          } catch {
            // An observer must never take down the connection's reader.
          }
        }
      });
      client.onDisconnect(() => {
        if (connection === opening) connection = null;
      });
      return client;
    });
  opening.catch(() => {
    if (connection === opening) connection = null;
  });
  connection = opening;
  return opening;
}

/**
 * Hearthside: for the few exchanges that are not one request and one reply —
 * a mod's slash command answers with a canonical lifecycle delta and no
 * response frame at all (see libs/mods/command-observer.ts). The connection
 * stays owned here; callers get it only for the duration of the call.
 */
export type ControlLease = {
  /** The socket this work is pinned to, for its whole duration. */
  client: AppServerClient;
  /** The generation that socket provably belongs to. */
  generation: number;
};

/**
 * A client and the generation it belongs to, as one thing.
 *
 * Reading the generation after opening the connection would be a lie when the
 * target changed while the socket was still opening: the caller would be
 * handed the old runtime's client stamped with the new runtime's generation,
 * and every later generation check would pass. So the generation is taken
 * before the wait and verified after it — if it moved, this connection is not
 * the current one and the caller gets nothing.
 */
export async function withControlClient<T>(use: (lease: ControlLease) => Promise<T>): Promise<T> {
  const before = generation;
  const client = await connect();
  if (generation !== before) {
    throw new Error("Hearthside reconnected while it was opening the connection, so nothing was sent. Try again.");
  }
  return use({ client, generation: before });
}

function isReply(message: unknown, type: string, requestId: string): message is Reply {
  const reply = message as Reply | null;
  return reply?.type === type && reply.request_id === requestId;
}

/** Send one command and wait for its response. Throws if the server reports failure. */
export async function request<TResponse extends Reply>(
  type: string,
  body: Record<string, unknown>,
  /** Hearthside: some commands (memory commits on big memories) can take a while. */
  timeoutMs?: number,
): Promise<TResponse> {
  const response = await requestAllowingFailure<Reply & Record<string, unknown>>(type, body, timeoutMs);
  if (response.success === false) {
    const output = typeof response.output === "string" ? response.output : "";
    throw new Error(response.error ?? (output || `${type} failed.`));
  }
  return response as unknown as TResponse;
}

/**
 * Hearthside: the same exchange for commands whose failure is an answer rather
 * than an exception — the ChatGPT usage commands report a code and a message
 * the window shows as it is ("not connected", "rate limited"), which a thrown
 * string would flatten. The caller gets the response frame either way.
 */
export async function requestAllowingFailure<TResponse extends { type: string; success?: boolean }>(
  type: string,
  body: Record<string, unknown>,
  timeoutMs?: number,
): Promise<TResponse> {
  return sendAllowingFailure<TResponse>(await connect(), type, body, timeoutMs);
}

/**
 * Hearthside: the same exchange on a socket the caller already holds a lease
 * on, refusing to send if the connection has moved on since the lease was
 * taken.
 *
 * `requestAllowingFailure` opens the connection itself, which means the
 * decision to send is always made before the socket exists — fine for a read,
 * wrong for a command that cannot be taken back. Spending a ChatGPT reset is
 * final, so it is sent through here: the generation is checked with the client
 * in hand and nothing awaited in between, so the send either goes out on the
 * socket it was authorised against or doesn't go out at all.
 */
export async function requestAllowingFailureOn<TResponse extends { type: string; success?: boolean }>(
  lease: ControlLease,
  type: string,
  body: Record<string, unknown>,
  timeoutMs?: number,
): Promise<TResponse> {
  if (lease.generation !== generation) {
    throw new Error("Hearthside reconnected, so nothing was sent on the connection this was prepared for. Try again.");
  }
  return sendAllowingFailure<TResponse>(lease.client, type, body, timeoutMs);
}

/** The exchange itself, on a client the caller has already decided to send on. */
async function sendAllowingFailure<TResponse extends { type: string; success?: boolean }>(
  client: AppServerClient,
  type: string,
  body: Record<string, unknown>,
  timeoutMs?: number,
): Promise<TResponse> {
  const requestId = client.nextRequestId(type);
  const response = await client.requestRaw<Reply & Record<string, unknown>>(
    { type, request_id: requestId, ...body },
    {
      predicate: (message): message is Reply & Record<string, unknown> =>
        isReply(message, `${type}_response`, requestId),
      ...(timeoutMs ? { timeoutMs } : {}),
    },
  );
  return response as unknown as TResponse;
}

/** Send a command whose response arrives in chunks, each ending with `done`. */
export async function requestChunks<TResponse extends Reply & { done: boolean }>(
  type: string,
  body: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<TResponse[]> {
  const client = await connect();
  const requestId = client.nextRequestId(type);

  return new Promise((resolve, reject) => {
    const chunks: TResponse[] = [];
    const finish = (error?: Error) => {
      clearTimeout(timer);
      stopListening();
      stopWatching();
      if (error) reject(error);
      else resolve(chunks);
    };
    const timer = setTimeout(() => finish(new Error(`${type} timed out.`)), timeoutMs);
    const stopWatching = client.onDisconnect(() => finish(new Error("Lost the connection to Letta.")));
    const stopListening = client.onMessage((message) => {
      if (!isReply(message, `${type}_response`, requestId)) return;
      const chunk = message as TResponse;
      if (chunk.success === false) {
        finish(new Error(chunk.error ?? `${type} failed.`));
        return;
      }
      chunks.push(chunk);
      if (chunk.done) finish();
    });
    client.sendRaw({ type, request_id: requestId, ...body });
  });
}

/**
 * Which harness backend the server runs ("local" stores agents on its
 * machine). Also the version gate: throws for a runtime whose protocol this
 * build does not understand, so the connection fails with a clear message.
 */
export async function serverBackend(): Promise<string | null> {
  let info: Awaited<ReturnType<AppServerClient["info"]>>;
  try {
    info = await (await connect()).info();
  } catch {
    return null;
  }
  if (!(SUPPORTED_PROTOCOL_VERSIONS as readonly number[]).includes(info.protocol_version)) {
    throw new Error(
      `This Letta runtime (letta-code ${info.letta_code_version}) speaks protocol ${info.protocol_version}, which this version of Hearthside does not support. Update Hearthside.`,
    );
  }
  return info.backend ?? null;
}

/**
 * Hearthside: the helpers the runtime holds for one chat right now, from a resync (which replays
 * update_subagent_state to whoever asked). Null when the runtime couldn't be asked.
 */
export async function subagentSnapshot(runtime: { agent_id: string; conversation_id: string }): Promise<unknown[] | null> {
  let client: Awaited<ReturnType<typeof connect>>;
  try {
    client = await connect();
  } catch {
    return null;
  }
  let snapshot: unknown[] | null = null;
  const unsubscribe = client.onMessage((message) => {
    const frame = message as unknown as { type?: string; runtime?: { agent_id?: string; conversation_id?: string }; subagents?: unknown[] };
    if (frame.type !== "update_subagent_state" || frame.runtime?.agent_id !== runtime.agent_id || frame.runtime?.conversation_id !== runtime.conversation_id) return;
    if (Array.isArray(frame.subagents)) snapshot = frame.subagents;
  });
  try {
    const reply = await client.sync({ runtime, recover_approvals: false, resume_interrupted_turn: false }, { timeoutMs: 5_000 });
    return reply.success === true ? (snapshot ?? []) : null;
  } catch {
    return null;
  } finally {
    unsubscribe();
  }
}

/** Fail closed if the runtime cannot prove that the conversation and its queue are idle. */
export async function runtimeIdle(runtime: { agent_id: string; conversation_id: string }): Promise<boolean> {
  try {
    return await observeRuntimeIdle(await connect(), runtime);
  } catch {
    return false;
  }
}

/**
 * Hearthside: the runtime's device status for one chat (toolset, loaded tools,
 * skills…), which it replays when asked to sync.
 */
export async function deviceStatus(runtime: { agent_id: string; conversation_id: string }, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  const client = await connect();
  const requestId = client.nextRequestId("sync");
  return new Promise((resolve, reject) => {
    const finish = (error: Error | null, status?: Record<string, unknown>) => {
      clearTimeout(timer);
      stopListening();
      if (error) reject(error);
      else resolve(status ?? {});
    };
    const timer = setTimeout(() => finish(new Error("The runtime didn't report its status.")), timeoutMs);
    const stopListening = client.onMessage((message) => {
      const frame = message as unknown as { type?: string; runtime?: { agent_id?: string; conversation_id?: string }; device_status?: Record<string, unknown> };
      if (frame.type !== "update_device_status" || !frame.device_status) return;
      if (frame.runtime?.agent_id !== runtime.agent_id || frame.runtime?.conversation_id !== runtime.conversation_id) return;
      finish(null, frame.device_status);
    });
    client.sendRaw({ type: "sync", runtime, request_id: requestId, recover_approvals: false, force_device_status: true } as never);
  });
}
