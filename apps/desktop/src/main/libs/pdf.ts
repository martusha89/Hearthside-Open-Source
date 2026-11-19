import type { Attachment } from "@hearthside/ipc-contract";

/**
 * Hearthside: PDFs are sent to the agent as their text, read with Mozilla's
 * pdf.js (Apache-2.0). Models only take text and images, so a PDF that is only
 * scanned pictures has nothing to send and is refused with a reason.
 */

const MAX_PAGES = 300;
const MAX_CHARS = 200_000;

type PdfAttachment = Extract<Attachment, { kind: "pdf" }>;
type TextAttachment = Extract<Attachment, { kind: "text" }>;

export async function pdfText(data: Uint8Array): Promise<{ text: string; pages: number; truncated: boolean }> {
  // pdf.js is an ES module; load it on first use.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  try {
    const pages: string[] = [];
    let length = 0;
    const count = Math.min(doc.numPages, MAX_PAGES);
    for (let number = 1; number <= count && length < MAX_CHARS; number++) {
      const page = await doc.getPage(number);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str + (item.hasEOL ? "\n" : "");
      }
      text = text.replace(/[ \t]+\n/g, "\n").trim();
      if (text) {
        pages.push(`--- Page ${number} ---\n${text}`);
        length += text.length;
      }
    }
    const joined = pages.join("\n\n");
    const truncated = doc.numPages > MAX_PAGES || joined.length > MAX_CHARS;
    return { text: joined.slice(0, MAX_CHARS), pages: doc.numPages, truncated };
  } finally {
    await task.destroy();
  }
}

/** Replace PDF attachments with their text, ready to send. */
export async function resolvePdfs(attachments: readonly Attachment[]): Promise<Attachment[]> {
  return Promise.all(
    attachments.map(async (item): Promise<Attachment> => {
      if (item.kind !== "pdf") return item;
      return pdfAttachmentText(item);
    }),
  );
}

async function pdfAttachmentText(item: PdfAttachment): Promise<TextAttachment> {
  let result: Awaited<ReturnType<typeof pdfText>>;
  try {
    result = await pdfText(new Uint8Array(Buffer.from(item.data, "base64")));
  } catch {
    throw new Error(`${item.name} couldn't be read. It may be damaged or password-protected.`);
  }
  if (!result.text) {
    throw new Error(`${item.name} has no text to read (it may be scanned pages). Try sending the pages as images instead.`);
  }
  const note = result.truncated ? `\n\n(Only the first part of this ${result.pages}-page PDF was included.)` : "";
  return { kind: "text", name: item.name, text: result.text + note };
}
