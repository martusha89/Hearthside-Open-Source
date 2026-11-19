/** Hearthside: lets the update install bypass the normal quit sequence. */
let markUpdateQuit: () => void = () => undefined;
let unmarkUpdateQuit: () => void = () => undefined;

export function setUpdateQuit(mark: () => void, unmark: () => void = () => undefined): void {
  markUpdateQuit = mark;
  unmarkUpdateQuit = unmark;
}

/**
 * The installer did not start after all. Without this the app stayed marked
 * as "quitting for an update" for good, and a later quit skipped its own
 * shutdown.
 */
export function cancelUpdateQuit(): void {
  unmarkUpdateQuit();
}

/** Never bypass before-quit while shutdown is pending or has failed. */
export async function prepareUpdateQuit(prepare: () => Promise<void>): Promise<void> {
  await prepare();
  markUpdateQuit();
}
