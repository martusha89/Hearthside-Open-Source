/**
 * Hearthside: what to show when "Restart to update" did not restart. The main
 * process words these for the person (a reply is still running, the update is
 * no longer there, shutdown failed); only Electron's wrapper is removed.
 */
export function updateFailureText(failure: unknown): string {
  const text = (failure instanceof Error ? failure.message : String(failure))
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, "")
    .trim();
  return text || "The update could not be installed. Try again in a moment.";
}
