import type {
  CanUseToolContext, CanUseToolResponse, LettaCodeSession, LettaCodeSocketConstructor,
  SDKMessage, SessionDeviceStatus,
} from "@letta-ai/letta-agent-sdk";
// `ws`, not Node's built-in WebSocket: the Cloud status socket is opened with
// an Authorization header, which the built-in cannot send.
import WebSocket from "ws";
import { observerOnlySocket, type ObserverSocketFault } from "./teleport-socket";

/**
 * Attaching to a native move's destination, as an observer.
 *
 * Hearthside does not own the computer the conversation moved to. The person's
 * permission mode, working directory, execution settings and skill sources
 * there are the destination's, and an attach that re-asserts this app's own
 * preferences is a silent configuration change on someone else's machine. The
 * Agent SDK offers no call-site way to attach without doing exactly that, so
 * the frames are narrowed one layer down — see `teleport-socket.ts` for which
 * fields are dropped and why each omission is safe.
 *
 * That socket is not optional here: `openSession` is handed the constructor it
 * must build its client on, so there is no call shape that attaches without it.
 *
 * What the attachment then has to do is *watch*. An attach that holds a session
 * and reads nothing from it is worse than no attach at all: the app would claim
 * the destination's approvals and Stop while showing none of its work. So the
 * stream, the approvals, the device status and the queue are all subscribed
 * here and handed to the caller's sink.
 */

/** A tool the destination is asking Hearthside about. */
export type DestinationApproval = {
  toolName: string;
  toolInput: Record<string, unknown>;
  context?: CanUseToolContext;
};

/**
 * Where a destination's activity goes.
 *
 * Deliberately a sink rather than an event emitter the caller may forget to
 * subscribe to: an attachment is constructed with somewhere for its messages to
 * go, or not at all.
 */
export type DestinationSink = {
  /** Every message the destination's stream yields, in order. */
  onMessage: (message: SDKMessage) => void;
  /**
   * The destination asked whether a tool may run.
   *
   * These arrive as control requests on the transport, independently of whether
   * this app started a turn, which is why an observer can answer them at all.
   */
  onApproval: (approval: DestinationApproval) => Promise<CanUseToolResponse>;
  onDeviceStatus: (status: SessionDeviceStatus) => void;
  /**
   * The stream ended, so this attachment has stopped observing. The
   * conversation is still at its destination; only the watching stopped.
   */
  onEnded: (reason?: string) => void;
};

export type DestinationAttachOptions = {
  /**
   * Open the destination session.
   *
   * Everything the attach must carry is passed in rather than left to the call
   * site: the observer socket the client has to be built on, and the approval
   * callback the session has to be created with.
   */
  openSession: (required: {
    WebSocket: LettaCodeSocketConstructor;
    canUseTool: (toolName: string, toolInput: Record<string, unknown>, context?: CanUseToolContext) => Promise<CanUseToolResponse>;
  }) => LettaCodeSession;
  /** The destination's connection ID, for the records the caller keeps. */
  connectionId: string;
  sink: DestinationSink;
};

export type DestinationAttachment = {
  connectionId: string;
  /**
   * Ask the destination to stop.
   *
   * Resolving means the destination accepted the request, not that the work
   * ended. Callers must keep showing "stopping" until the destination's own
   * activity says otherwise.
   */
  requestStop(): Promise<void>;
  /**
   * Carry over approvals the move handed to the destination.
   *
   * Explicit by design, and its answer is returned rather than discarded:
   * `unsupported` and an unresolved `pendingApproval` are different situations
   * from "recovered nothing", and the caller has to be able to say which.
   */
  recoverApprovals(): Promise<DestinationRecovery>;
  deviceStatus(): Promise<SessionDeviceStatus>;
  close(): void;
};

export type DestinationRecovery = {
  recovered: boolean;
  /** Undefined when the destination could not say. Not the same as false. */
  pendingApproval?: boolean;
  unsupported: boolean;
  detail?: string;
};

/**
 * Attach to a destination without prompting the agent.
 *
 * `ready()` initialises the runtime and transport without sending a model
 * request, and the observer socket forces `recover_approvals: false` on both
 * the attach frame and every `sync` the SDK sends afterwards — including the
 * ones it sends by itself on an idle reconnect or an event-sequence gap. Those
 * syncs are what could otherwise make the destination finish the source's
 * pending approvals as a turn of its own; carrying them over stays an explicit
 * `recoverApprovals()` call that something has to ask for.
 *
 * A frame the socket cannot vouch for fails the attach rather than being sent,
 * so a destination Hearthside cannot observe safely is left exactly as it was.
 */
export async function attachToDestination(options: DestinationAttachOptions): Promise<DestinationAttachment> {
  const { sink } = options;
  // A holder, not a plain `let`: the socket records its fault from inside a
  // callback, and a reference the compiler can see through is what keeps the
  // refusal reason available to every later read.
  const fault: { current: ObserverSocketFault | null } = { current: null };
  let closed = false;

  const session = options.openSession({
    WebSocket: observerOnlySocket(WebSocket, (observed) => { fault.current ??= observed; }) as never,
    canUseTool: (toolName, toolInput, context) => sink.onApproval({
      toolName, toolInput, ...(context ? { context } : {}),
    }),
  });

  try {
    await session.ready();
  } catch (error) {
    session.close();
    // A refused frame is the real reason; the SDK's own error is the symptom.
    throw fault.current ? new Error(fault.current.reason) : error;
  }
  if (fault.current) {
    session.close();
    throw new Error(fault.current.reason);
  }

  const stopWatchingStatus = session.onDeviceStatus((status) => {
    if (!closed) sink.onDeviceStatus(status);
  });

  // Read the destination's stream for as long as the attachment lives. An
  // observer is never sent a terminal `result` — the SDK only completes a turn
  // it started itself — so this loop ends when the session does, not when the
  // destination's work does.
  void (async () => {
    try {
      for await (const message of session.stream()) {
        if (closed) return;
        sink.onMessage(message);
      }
      if (!closed) sink.onEnded(fault.current?.reason);
    } catch (error) {
      if (!closed) sink.onEnded(fault.current?.reason ?? (error instanceof Error ? error.message : String(error)));
    }
  })();

  return {
    connectionId: options.connectionId,
    async requestStop() { await session.abort(); },
    async recoverApprovals() {
      const outcome = await session.recoverPendingApprovals({ timeoutMs: 5_000 });
      return {
        recovered: outcome.recovered,
        unsupported: outcome.unsupported,
        ...(outcome.pendingApproval === undefined ? {} : { pendingApproval: outcome.pendingApproval }),
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      };
    },
    deviceStatus: () => session.getDeviceStatus({ timeoutMs: 5_000 }),
    close: () => {
      closed = true;
      stopWatchingStatus();
      session.close();
    },
  };
}
