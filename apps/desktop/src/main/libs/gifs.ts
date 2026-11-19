import { randomUUID } from "node:crypto";
import type { AnyAgentTool } from "@letta-ai/letta-agent-sdk";
import type { GifFilter } from "@hearthside/ipc-contract";

/**
 * Hearthside: GIFs from KLIPY. The agent gets one small tool, send_gif; the
 * chat shows the GIF inline with KLIPY's attribution. The app key is baked in
 * at build time (MAIN_VITE_SOURCE_KLIPY_API_KEY, from .env locally or a GitHub secret
 * for releases) and never reaches the window.
 */

export const GIF_TOOL_NAME = "send_gif";
const API = "https://api.klipy.com/api/v1";

export function klipyKey(): string {
  return (import.meta.env.MAIN_VITE_SOURCE_KLIPY_API_KEY ?? "").trim();
}

export function gifsAvailable(): boolean {
  return klipyKey().length > 0;
}

export type Gif = { id: string; title: string; url: string; width: number; height: number; page: string };

type KlipyFile = { url?: string; width?: number; height?: number };
type KlipyItem = { id?: number | string; slug?: string; title?: string; type?: string; file?: Record<string, Record<string, KlipyFile>> };

function toGif(item: KlipyItem, fallbackTitle: string): (Gif & { preview: string }) | null {
  if (item.type && item.type !== "gif") return null;
  const file = item.file?.md?.gif ?? item.file?.sm?.gif ?? item.file?.hd?.gif;
  if (!file?.url) return null;
  const preview = item.file?.sm?.webp?.url ?? item.file?.sm?.gif?.url ?? file.url;
  return {
    id: String(item.id ?? item.slug ?? ""),
    title: item.title ?? fallbackTitle,
    url: file.url,
    preview,
    width: file.width ?? 0,
    height: file.height ?? 0,
    page: item.slug ? `https://klipy.com/gifs/${item.slug}` : "https://klipy.com",
  };
}

/** GIFs for the picker: a search, or what's trending when the search is empty. */
export async function listGifs(query: string, filter: GifFilter, customerId: string, fetchImpl: typeof fetch = fetch): Promise<Array<Gif & { preview: string }>> {
  const key = klipyKey();
  if (!key) throw new Error("GIFs aren't set up in this build.");
  const q = query.trim().slice(0, 100);
  const params = new URLSearchParams({ page: "1", per_page: "24", customer_id: customerId, locale: "en", content_filter: filter, ...(q ? { q } : {}) });
  const response = await fetchImpl(`${API}/${encodeURIComponent(key)}/gifs/${q ? "search" : "trending"}?${params}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`KLIPY answered ${response.status}.`);
  const body = (await response.json()) as { data?: { data?: KlipyItem[] } };
  return (body.data?.data ?? []).map((item) => toGif(item, q || "GIF")).filter((gif): gif is Gif & { preview: string } => gif !== null);
}

/** The first real GIF (not an ad) for a search, in a chat-friendly size. */
export async function searchGif(query: string, filter: GifFilter, customerId: string, fetchImpl: typeof fetch = fetch): Promise<Gif | null> {
  const key = klipyKey();
  if (!key) throw new Error("GIFs aren't set up in this build.");
  const params = new URLSearchParams({ q: query, page: "1", per_page: "8", customer_id: customerId, locale: "en", content_filter: filter });
  const response = await fetchImpl(`${API}/${encodeURIComponent(key)}/gifs/search?${params}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`KLIPY answered ${response.status}.`);
  const body = (await response.json()) as { data?: { data?: KlipyItem[] } };
  for (const item of body.data?.data ?? []) {
    if (item.type && item.type !== "gif") continue;
    const file = item.file?.md?.gif ?? item.file?.sm?.gif ?? item.file?.hd?.gif;
    if (!file?.url) continue;
    return {
      id: String(item.id ?? item.slug ?? ""),
      title: item.title ?? query,
      url: file.url,
      width: file.width ?? 0,
      height: file.height ?? 0,
      page: item.slug ? `https://klipy.com/gifs/${item.slug}` : "https://klipy.com",
    };
  }
  return null;
}

/** A KLIPY GIF's bytes, base64 (KLIPY's image server only, up to 15 MB). */
export async function fetchGif(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== "static.klipy.com" || !parsed.pathname.endsWith(".gif")) throw new Error("Only KLIPY GIFs.");
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`KLIPY answered ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 15 * 1024 * 1024) throw new Error("That GIF is too big.");
  return bytes.toString("base64");
}

export function newCustomerId(): string {
  return randomUUID();
}

/** The agent's tool. Its result carries the GIF link, which the chat shows as the GIF. */
export function createGifTool(options: { filter: () => GifFilter; customerId: () => string }): AnyAgentTool {
  return {
    name: GIF_TOOL_NAME,
    label: "Send a GIF",
    description:
      "Send the user a GIF that fits the moment (a reaction, a hug, a happy dance). Describe it in a few words; it appears in the chat. Use it now and then, like a person would, not in every message. To share it on Telegram or Discord, include the GIF link from the result in your message there.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "A few words describing the GIF, e.g. 'warm hug', 'excited dance', 'sleepy cat'." },
      },
      required: ["query"],
    },
    execute: async (_toolCallId, args) => {
      const query = String((args as { query?: unknown })?.query ?? "").trim().slice(0, 100);
      if (!query) return { content: [{ type: "text", text: "Say what kind of GIF to send." }], isError: true };
      try {
        const gif = await searchGif(query, options.filter(), options.customerId());
        if (!gif) return { content: [{ type: "text", text: `No GIF found for "${query}". Try other words.` }], isError: true };
        return { content: [{ type: "text", text: `GIF sent: ${gif.title}\nGIF link: ${gif.url}` }] };
      } catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    },
  };
}
