import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Hearthside: one change at a time per bot.
 *
 * Every change to a bot is an owner check followed by runtime calls — read who
 * owns it, ask the runtime, write the result. The check and the effect are
 * therefore separated by awaits, and anything that changed the bot in between
 * used to land on the new state: an approval authorised for one companion
 * binding a chat to another, a claim writing an owner over a move, the
 * five-second Discord maintenance pass re-pointing chats a move had just
 * carried over. Every one of those is a different door into the same room, so
 * they are closed in one place rather than one at a time.
 *
 * The whole operation runs inside the queue, not only its writes: the runtime
 * calls are the part that takes time, so serialising the writes alone would
 * leave exactly the gap this exists to close. Each step is a bounded runtime
 * call (the channel gateway times a command out after 30s), so a queue moves on
 * even when the service is unwell.
 *
 * Nesting is allowed for the SAME bot and refused for any other. An operation
 * calling a smaller one — approving a request then locking the bot to the person
 * approved — runs straight through, because the queue it would wait for is the
 * one it is already holding. Waiting for a second bot while holding the first is
 * the one shape that could deadlock (two operations taking two bots in opposite
 * orders), so it is refused loudly instead of hanging; nothing here does it.
 *
 * Owner checks are still made again inside the queue, right before the effect.
 * This serialises Hearthside's own changes; it is not a reason to trust a record
 * that was read before an await.
 */

type Held = { accounts: ReadonlySet<string>; active: boolean };
const holding = new AsyncLocalStorage<Held>();
/** The tail of each bot's queue, dropped once that bot has nothing in flight. */
const queues = new Map<string, Promise<unknown>>();

/** Background services are independent callers, never nested bot operations. */
export function withoutBotContext<T>(work: () => T): T {
  return holding.exit(work);
}

/**
 * Run `work` with this bot to itself. Anything else for the same bot waits.
 *
 * A bot with no id isn't a bot yet (a setup before the runtime has made the
 * account), so there is nothing to queue on and the work runs as it is.
 */
export function withBot<T>(accountId: string, work: () => Promise<T>): Promise<T> {
  if (!accountId) return work();
  const held = holding.getStore();
  if (held?.active) {
    if (held.accounts.has(accountId)) return work();
    return Promise.reject(new Error(`A change to bot ${[...held.accounts].join(", ")} must not wait for bot ${accountId}: two bots at once could deadlock.`));
  }
  const previous = queues.get(accountId) ?? Promise.resolve();
  const task = previous.then(() => {
    const scope: Held = { accounts: new Set([accountId]), active: true };
    return holding.run(scope, async () => {
      try {
        return await work();
      } finally {
        // Async resources can inherit this context and outlive the operation.
        // They must queue normally once its actual lock has been released.
        scope.active = false;
      }
    });
  });
  // The queue must not carry a failure forwards: the rejection goes to whoever
  // asked for the work, while the tail the next caller waits on always settles.
  const tail: Promise<void> = task.then(
    () => undefined,
    () => undefined,
  ).then(() => {
    if (queues.get(accountId) === tail) queues.delete(accountId);
  });
  queues.set(accountId, tail);
  return task;
}

/** Whether a change to this bot is in flight on this call's own queue (tests, logging). */
export function holdingBot(accountId: string): boolean {
  const held = holding.getStore();
  return held?.active === true && held.accounts.has(accountId);
}
