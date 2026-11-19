


export class DownloadTooBig extends Error {
  constructor() {
    super("The download is bigger than Hearthside accepts.");
  }
}

/** Read a response body, stopping (and cancelling the download) past maxBytes. */
export async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new DownloadTooBig();
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new DownloadTooBig();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export interface SafeFetchOptions {
  headers?: Record<string, string>;
  /** Sent only to hosts `trusted` accepts, checked again at every redirect. */
  authorization?: string | null;
  trusted?: (url: URL) => boolean;
  timeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

/** fetch with https-only manual redirects; the token never leaves trusted hosts. */
export async function safeFetch(url: string, options: SafeFetchOptions = {}): Promise<Response> {
  let current = new URL(url);
  const maxRedirects = options.maxRedirects ?? 3;
  const signals = [AbortSignal.timeout(options.timeoutMs ?? 60_000), ...(options.signal ? [options.signal] : [])];
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (current.protocol !== "https:") throw new Error("Only https addresses are downloaded.");
    if (current.username || current.password) throw new Error("Addresses with a name and password in them aren't downloaded.");
    const send = Boolean(options.authorization && options.trusted?.(current));
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.any(signals),
      headers: { ...options.headers, ...(send ? { Authorization: options.authorization! } : {}) },
    });
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      const next = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!next) throw new Error("The address redirected nowhere.");
      current = new URL(next, current);
      continue;
    }
    return response;
  }
  throw new Error("The address redirected too many times.");
}

/** A host check for one site and its subdomains, e.g. siteOf("elevenlabs.io"). */
export function hostIsOrUnder(host: string, site: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const s = site.toLowerCase();
  return h === s || h.endsWith(`.${s}`);
}
