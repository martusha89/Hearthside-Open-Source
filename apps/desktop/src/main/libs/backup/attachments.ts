import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

export type AttachmentResolver = {
  origin: string;
  /** Provider-owned endpoint implementation. Never receives arbitrary external URLs. */
  resolve(descriptor: { fileId: string; origin: string }, signal: AbortSignal): Promise<{ bytes: Buffer; mediaType: string }>;
};
export type AttachmentRecord = { location: string; status: "captured" | "omitted" | "unresolved-external"; reason?: string; mediaType?: string; reference?: string; hash?: string; size?: number };
export type AttachmentTransport = {
  lookup(host: string): Promise<Array<{ address: string; family: number }>>;
  get(url: URL, address: { address: string; family: number }, signal: AbortSignal, maxBytes: number): Promise<{ status: number; location?: string; mediaType?: string; bytes: Buffer }>;
};
const MAX_BYTES = 20 * 1024 * 1024;
const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
// Conservative: IPv6 is unsupported rather than attempting incomplete special-range filtering.
export function publicAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a = 0, b = 0] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168 || b === 2)) || (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0));
}
const transport: AttachmentTransport = {
  lookup: (host) => lookup(host, { all: true }),
  get: (url, address, signal, maxBytes) => new Promise((resolve, reject) => {
    const req = request(url, {
      signal, agent: false, family: 4, headers: { Accept: "*/*" },
      // Pin the vetted address, retaining the original hostname for TLS verification.
      lookup: ((_host: unknown, _options: unknown, callback: (error: null, address: string, family: number) => void) => callback(null, address.address, address.family)) as never,
    }, (res) => {
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) { res.destroy(new Error("byte-limit")); } else chunks.push(chunk); });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, mediaType: res.headers["content-type"]?.split(";")[0]?.trim(), bytes: Buffer.concat(chunks) }));
    });
    req.on("error", reject); req.end();
  }),
};
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("timeout"));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
function safeReference(raw: string): string {
  try { const url = new URL(raw); return `${url.protocol}//${url.host}${url.pathname}`; } catch { return "provider-file"; }
}
export async function fetchAttachment(raw: string, signal: AbortSignal, net = transport, maxBytes = MAX_BYTES): Promise<{ bytes: Buffer; mediaType: string }> {
  let url = new URL(raw);
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new Error("unsafe-url");
    const addresses = await bounded(net.lookup(url.hostname), signal);
    if (!addresses.length || addresses.some((a) => !publicAddress(a.address))) throw new Error("private-or-unsupported-address");
    signal.throwIfAborted();
    const response = await bounded(net.get(url, addresses[0]!, signal, maxBytes), signal);
    if (response.status >= 300 && response.status < 400 && response.location) { url = new URL(response.location, url); continue; }
    if (response.status === 401 || response.status === 403) throw new Error("authentication-required-or-expired");
    if (response.status === 404 || response.status === 410) throw new Error("expired-or-missing");
    if (response.status !== 200) throw new Error("http-failure");
    if (response.bytes.length > maxBytes) throw new Error("byte-limit");
    if (!response.mediaType || !MIME.test(response.mediaType)) throw new Error("invalid-media-type");
    return { bytes: response.bytes, mediaType: response.mediaType };
  }
  throw new Error("redirect-limit");
}
function decode(raw: string): Buffer {
  const text = raw.replace(/\s/g, "");
  if (text.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new Error("invalid-or-oversized-base64");
  return Buffer.from(text, "base64");
}


const CAPTURE_BUDGET_MS = 60_000;
const ONE_ATTACHMENT_MS = 10_000;
const MAX_ATTACHMENTS = 100;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

export class AttachmentCollector {
  readonly inventory: AttachmentRecord[] = [];
  private count = 0;
  private total = 0;
  /** Milliseconds actually spent fetching attachments, not elapsed since start. */
  private spent = 0;
  constructor(private includePictures: boolean, private put: (bytes: Buffer) => string, private resolver?: AttachmentResolver, private net = transport) {}
  private remainingMs(): number {
    return CAPTURE_BUDGET_MS - this.spent;
  }
  async lift(value: unknown, location = "message", inheritedType?: string): Promise<unknown> {
    if (Array.isArray(value)) { const out: unknown[] = []; for (let i = 0; i < value.length; i++) out.push(await this.lift(value[i], `${location}/${i}`, inheritedType)); return out; }
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    const type = typeof object.type === "string" ? object.type : inheritedType;
    const audioFormat = object.format === "wav" ? "audio/wav" : object.format === "mp3" ? "audio/mpeg" : undefined;
    const mime = object.media_type ?? object.mediaType ?? object.mime_type ?? object.mimeType ?? (/audio/.test(type ?? "") ? audioFormat : undefined);
    const typed = typeof mime === "string" || /^(image|image_url|input_image|audio|input_audio|file|input_file|document|attachment)$/.test(type ?? "");
    const copy: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(object)) {
      const inline = (key === "data" || key === "base64") && typeof mime === "string";
      const external = (key === "url" || key === "image_url" || key === "file_data" || key === "file_path") && typed;
      const fileId = (key === "file_id" || key === "attachment_id") && typed;
      if (typeof inner !== "string" || !(inline || external || fileId)) { copy[key] = await this.lift(inner, `${location}/${key}`, typed ? type : undefined); continue; }
      const item: AttachmentRecord = { location: `${location}/${key}`, status: "unresolved-external", ...(typeof mime === "string" ? { mediaType: mime } : {}), ...(!inline ? { reference: fileId && /^[A-Za-z0-9_-]{1,200}$/.test(inner) ? inner : safeReference(inner) } : {}) };
      this.inventory.push(item);
      try {
        if (key === "file_path") throw new Error("unsupported-local-path");
        // Classify before counting. A picture nobody asked us to copy costs no request
        // and no bytes, so it must not spend one of the hundred slots — and once the
        // cap was reached it was being reported as `capture-limit`, which told the
        // person their backup hit a bound when in fact they had pictures switched off.
        if (!this.includePictures && (String(mime).startsWith("image/") || /image/.test(type ?? ""))) { item.status = "omitted"; item.reason = "pictures-disabled"; copy[`${key}_hearthside_omitted`] = true; continue; }
        // A file ID we cannot capture is settled here, before the counter and before the
        // budget: no endpoint of ours returns the original bytes (see the backup ticket),
        // so this build ships no resolver, and a descriptor pointing somewhere other than
        // the configured provider is refused outright. Neither decision makes a request or
        // waits for one. Taken later, a hundred provider file IDs spent all hundred slots
        // so the next real attachment reported `capture-limit`, and after the fetch budget
        // ran out they reported `time-limit` — both of which name the wrong cause.
        let resolver: AttachmentResolver | undefined;
        if (fileId) {
          if (!this.resolver) throw new Error("file-id-capture-unsupported");
          if (object.origin !== this.resolver.origin || new URL(this.resolver.origin).origin !== this.resolver.origin) throw new Error("foreign-provider-origin");
          resolver = this.resolver;
        }
        if (++this.count > MAX_ATTACHMENTS || this.total >= MAX_TOTAL_BYTES) throw new Error("capture-limit");
        let result: { bytes: Buffer; mediaType: string };
        if (inline) { if (!MIME.test(String(mime))) throw new Error("invalid-media-type"); result = { bytes: decode(inner), mediaType: String(mime) }; }
        else if (!fileId && inner.startsWith("data:")) {
          // A data: URL carries its own bytes in the descriptor. Decoding them reaches no
          // network and waits for nothing, so it is charged nothing and stays allowed once
          // the fetch budget is gone — the same treatment as an inline base64 payload.
          const match = /^data:([^;,]+);base64,(.*)$/s.exec(inner); if (!match || !MIME.test(match[1]!)) throw new Error("unsupported-data-url");
          result = { bytes: decode(match[2]!), mediaType: match[1]! };
        }
        else {
          if (this.remainingMs() <= 0) throw new Error("time-limit");
          const signal = AbortSignal.timeout(Math.max(1, Math.min(ONE_ATTACHMENT_MS, this.remainingMs())));
          // Monotonic: the wall clock can step backwards mid-backup (an NTP correction, a
          // person fixing the time zone), and a negative interval would hand the budget
          // time back instead of spending it.
          const startedAt = performance.now();
          try {
            if (resolver) result = await bounded(resolver.resolve({ fileId: inner, origin: resolver.origin }, signal), signal);
            else result = await fetchAttachment(inner, signal, this.net);
          } finally {
            // Charged whether it succeeded or failed: a minute of timeouts is still a
            // minute, and the next attachment must not be able to spend it again.
            this.spent += performance.now() - startedAt;
          }
        }
        if (!MIME.test(result.mediaType) || (typeof mime === "string" && mime.toLowerCase() !== result.mediaType.toLowerCase()) || (/image/.test(type ?? "") && !result.mediaType.startsWith("image/")) || (/audio/.test(type ?? "") && !result.mediaType.startsWith("audio/"))) throw new Error("media-type-mismatch");
        if (result.bytes.length > MAX_BYTES || this.total + result.bytes.length > MAX_TOTAL_BYTES) throw new Error("byte-limit");
        if (!this.includePictures && result.mediaType.startsWith("image/")) { item.status = "omitted"; item.reason = "pictures-disabled"; copy[`${key}_hearthside_omitted`] = true; continue; }
        this.total += result.bytes.length; item.hash = this.put(result.bytes); item.size = result.bytes.length; item.mediaType = result.mediaType; item.status = "captured";
        copy[`${key}_hearthside_object`] = item.hash; copy[`${key}_bytes`] = item.size;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "capture-failed";
        item.reason = /^[a-z-]+$/.test(reason) ? reason : "capture-failed";
        copy[key] = inner; // Preserve original descriptor for a future retry; inventory never logs query credentials.
      }
    }
    return copy;
  }
}
