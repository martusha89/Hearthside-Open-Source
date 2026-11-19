


const SLICE_MS = 25;
let sliceStart = Date.now();

/** Test support: told where long stretches without a breath end, to find what blocks. */
let probe: ((gapMs: number, where: string) => void) | null = null;
let lastCall = Date.now(), lastWhere = "";
export function probeStalls(listener: typeof probe): void { probe = listener; lastCall = Date.now(); }

/** Give the event loop a turn if the current slice has run long. */
export async function breathe(): Promise<void> {
  if (probe) {
    const now = Date.now(), where = new Error().stack?.split("\n").slice(2, 5).join(" | ") ?? "";
    probe(now - lastCall, `${lastWhere}  ==>  ${where}`);
    lastCall = now; lastWhere = where;
  }
  if (Date.now() - sliceStart < SLICE_MS) return;
  await new Promise<void>((resolve) => setImmediate(resolve));
  sliceStart = Date.now();
}

/** Run stepped work straight through. */
export function drain<T>(steps: Generator<unknown, T, undefined>): T {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/** Run stepped work, letting the event loop in between slices. */
export async function drainAsync<T>(steps: Generator<unknown, T, undefined>): Promise<T> {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    await breathe();
  }
}
