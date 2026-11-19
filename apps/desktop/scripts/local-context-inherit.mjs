// Exact-contract Letta 0.34.36 fix applied to the validated runtime copy.
//
// A local chat that was given its own context window could never go back to
// its agent's. Every reader of the stored limit treats "not a number" as "use
// the agent's", but the update only ever stored a number and ignored a cleared
// one, so the old limit stayed for good. Clearing it now removes it, which is
// what makes the chat follow the agent again — including when the agent's own
// window is changed later.
export function transformLocalContextInherit(source) {
  const from = `  if (typeof bodyRecord.context_window_limit === "number") {
    next.context_window_limit = bodyRecord.context_window_limit;
  }`;
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`Local context inherit contract mismatch: expected 1 conversation update seam, found ${count}`);
  return source.replace(from, `${from}
  if (bodyRecord.context_window_limit === null) {
    delete next.context_window_limit;
  }`);
}
