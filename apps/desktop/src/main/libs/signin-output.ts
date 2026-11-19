// Turns the text `letta connect <provider>` prints into what the sign-in
// dialog needs: a page to open, a one-time code, or a question to answer.
// Pure so it can be tested against real CLI output.

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const URL_RE = /https?:\/\/[^\s"'<>]+/;
const CODE_RE = /(?:enter|user)\s+code:?\s*([A-Z0-9]{3,}(?:-[A-Z0-9]{3,})*)/i;

export interface SignInView {
  url: string | null;
  code: string | null;
  prompt: string | null;
  lines: string[];
}

export function cleanLine(line: string): string {
  return line.replace(ANSI, "").replace(/\s+$/, "");
}

/** Lines that ask the person to type something back. */
function promptFrom(line: string): string | null {
  const requires = line.match(/requires input:\s*(.+)$/i);
  if (requires?.[1]) return requires[1].trim();
  if (/paste .*(code|url)|enterprise url|\(blank for/i.test(line)) return line.trim();
  return null;
}

export function readSignInOutput(rawLines: readonly string[], maxLines = 12): SignInView {
  const lines = rawLines.map(cleanLine).filter((line) => line.trim() !== "");
  let url: string | null = null;
  let code: string | null = null;
  let prompt: string | null = null;
  for (const line of lines) {
    const foundUrl = line.match(URL_RE)?.[0];
    if (foundUrl) url = foundUrl;
    const foundCode = line.match(CODE_RE)?.[1];
    if (foundCode) code = foundCode.toUpperCase();
    const foundPrompt = promptFrom(line);
    if (foundPrompt) prompt = foundPrompt;
  }
  // URLs are shown as a button; keep them out of the text so long OAuth links don't flood it.
  const text = lines.filter((line) => !URL_RE.test(line) || line.replace(URL_RE, "").trim().length > 12);
  return { url, code, prompt, lines: text.slice(-maxLines) };
}
