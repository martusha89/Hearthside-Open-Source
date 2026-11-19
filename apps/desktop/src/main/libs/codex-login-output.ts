import { cleanLine } from "./signin-output";

/**
 * Hearthside: reading what the Codex CLI says while signing in, and what it
 * says about being signed in.
 *
 * Pure, so it can be tested against the CLI's real wording. The wording below
 * was taken from Codex itself (`codex login`, `codex login --device-auth` and
 * `codex login status`, release 0.151.0) rather than guessed.
 *
 * Two rules this file exists to keep:
 *
 *  - An address is only ever handed to the browser when it belongs to OpenAI's
 *    own sign-in. A program's output is not a reason to open something.
 *  - Being signed in is what the CLI reports, and *how* it is signed in matters:
 *    an API key is a different (billed) account than a ChatGPT plan, so it is
 *    never reported as a ChatGPT connection.
 */

/**
 * Where OpenAI signs people in. Exact hosts, not "ends with openai.com": a
 * lookalike subdomain should not be openable, and Codex only ever prints these.
 */
const LOGIN_HOSTS = new Set(["auth.openai.com", "chatgpt.com", "platform.openai.com"]);

/** Safe to open in the person's browser for a Codex sign-in? */
export function isOfficialLoginUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && LOGIN_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

const URL_RE = /https?:\/\/[^\s"'<>]+/g;
/** "Enter this one-time code" followed by the code, however it is spaced or punctuated. */
const LABELLED_CODE = /one-time code\b[^A-Za-z0-9]*([A-Z0-9]{4,}(?:-[A-Z0-9]{3,})*)/i;
/** A line that is nothing but a code, e.g. "ABCD-EFGH". Only trusted alongside a device page. */
const BARE_CODE = /^([A-Z0-9]{4,8}(?:-[A-Z0-9]{3,8})+)$/;

export type CodexAuthMode = "chatgpt" | "api-key" | "other";

export type CodexStatus = {
  /** The CLI reports a usable sign-in. */
  signedIn: boolean;
  /** How it is signed in; null when it isn't. */
  authMode: CodexAuthMode | null;
  /**
   * A short phrase for showing and logging. Chosen from the list below rather
   * than copied from the CLI: its "Logged in using an API key - …" line
   * carries part of the key, and that must not reach a window or a log file.
   */
  detail: string;
};

/**
 * The sign-in kinds Codex reports, as it words them. Matching a known phrase
 * and then using *our copy of it* is what keeps whatever follows it — a key, an
 * account id, an ARN — out of everything downstream.
 */
const KNOWN_SIGN_INS: Array<{ match: RegExp; detail: string; mode: CodexAuthMode }> = [
  { match: /logged in using chatgpt/i, detail: "Signed in with ChatGPT", mode: "chatgpt" },
  { match: /logged in using an api key/i, detail: "Signed in with an OpenAI API key", mode: "api-key" },
  { match: /logged in using personal access token/i, detail: "Signed in with a personal access token", mode: "other" },
  { match: /logged in using workload identity/i, detail: "Signed in with a workload identity", mode: "other" },
  { match: /logged in using amazon bedrock/i, detail: "Signed in with Amazon Bedrock", mode: "other" },
];

/**
 * What `codex login status` means. It exits 0 and says "Logged in using …"
 * when signed in, and exits 1 with "Not logged in" when not, so both are
 * checked: an exit code alone would call a crash a sign-out, and output alone
 * would ignore a CLI that failed to read its own store.
 */
export function readCodexStatus(output: string, exitCode: number | null): CodexStatus {
  const text = output
    .split(/\r?\n/)
    .map(cleanLine)
    .find((line) => /logged in/i.test(line))
    ?.trim();
  if (exitCode !== 0 || !text || /^not logged in/i.test(text)) {
    return { signedIn: false, authMode: null, detail: "Not signed in" };
  }
  const known = KNOWN_SIGN_INS.find((entry) => entry.match.test(text));
  // A kind this version of Hearthside doesn't know: say only that, never the line.
  return { signedIn: true, authMode: known?.mode ?? "other", detail: known?.detail ?? "Signed in, in a way Hearthside doesn't recognise" };
}

export type CodexLoginView = {
  /** OpenAI's sign-in page, when one has been printed. Never anything else. */
  url: string | null;
  /** The one-time code to type on that page (device-code sign-in). */
  code: string | null;
  /** Plain-language progress for the window. */
  message: string;
  /** Set once the CLI says the sign-in worked. */
  succeeded: boolean;
  /** A readable reason when the CLI gave one. */
  error: string | null;
};

/** Codex's own failures, said the way the person affected would say them. */
function friendlyError(line: string): string | null {
  if (/device code login is not enabled/i.test(line)) {
    return "Device-code sign-in is switched off for this account. Turn on device code login in ChatGPT's settings (Settings → Security), or use “Sign in with a browser” instead.";
  }
  if (/device auth timed out/i.test(line)) return "The one-time code expired before it was entered. Start the sign-in again.";
  if (/chatgpt login is disabled/i.test(line)) return "This ChatGPT workspace doesn't allow signing Codex in with a ChatGPT account.";
  if (/api key login is disabled/i.test(line)) return "This workspace doesn't allow API-key sign-in for Codex.";
  if (/error logging in with device code/i.test(line)) {
    return `Codex couldn't start the sign-in. ${line.replace(/^.*error logging in with device code:\s*/i, "").trim()}`.trim();
  }
  if (/^error:/i.test(line)) return line.replace(/^error:\s*/i, "").trim() || null;
  return null;
}

/**
 * Turn the CLI's output into what the card shows. The address is picked only
 * from OpenAI's sign-in hosts: the local callback server Codex also prints
 * (http://localhost:1455) belongs to Codex, not the browser, and anything else
 * in the output is not an invitation to open it.
 */
export function readCodexLogin(rawLines: readonly string[]): CodexLoginView {
  const lines = rawLines.map(cleanLine).filter((line) => line.trim() !== "");
  let url: string | null = null;
  let code: string | null = null;
  let error: string | null = null;
  let succeeded = false;
  let waitingForBrowser = false;

  for (const line of lines) {
    for (const candidate of line.match(URL_RE) ?? []) {
      // Trailing punctuation from prose, e.g. "…authenticate: <url>."
      const trimmed = candidate.replace(/[).,;]+$/, "");
      if (isOfficialLoginUrl(trimmed)) url = trimmed;
    }
    const labelled = line.match(LABELLED_CODE)?.[1];
    if (labelled) code = labelled.toUpperCase();
    else if (url && BARE_CODE.test(line.trim())) code = line.trim().toUpperCase();
    if (/successfully logged in/i.test(line)) succeeded = true;
    if (/starting local login server|finish signing in via your browser/i.test(line)) waitingForBrowser = true;
    const failure = friendlyError(line);
    if (failure) error = failure;
  }

  const message = error
    ? error
    : succeeded
      ? "Signed in."
      : code
        ? "Open the page, sign in, then type the code shown here."
        : url
          ? "Finish signing in to ChatGPT in your browser."
          : waitingForBrowser
            ? "Waiting for your browser…"
            : "Starting the ChatGPT sign-in…";
  return { url, code, message, succeeded, error };
}
