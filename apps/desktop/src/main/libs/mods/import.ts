import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ModImportPreview, ModImportResult } from "@hearthside/ipc-contract";
import { MAX_IMPORT_BYTES, readBoundedFile } from "./inventory";
import { isModFileName } from "./paths";

/**
 * Adding a mod file someone already trusts.
 *
 * Two steps on purpose. `previewModFile` reads the chosen file and hands back
 * its whole source with a token; nothing is written. `confirmModImport`
 * installs **the bytes that were previewed** — not a fresh read of the path.
 * A mod is fully trusted code: the runtime imports it and runs it with its own
 * file, network and process access, so what gets installed has to be the thing
 * the person actually read. A re-read would install whatever is at that path
 * now, and a same-length swap would pass every size check.
 *
 * The preview also records the context it was made in — which runtime's mods
 * folder, resolved through its real path. If any of that changed by the time
 * someone confirms, the preview is refused rather than written somewhere else.
 */

export type ImportContext = {
  /** The mods folder of the runtime that is live right now. */
  directory: string;
  /** Changes whenever the connection, account or runtime home changes. */
  identity: string;
};

type PendingImport = {
  token: string;
  from: string;
  name: string;
  /** The reviewed bytes themselves: what gets installed, and nothing else. */
  content: Buffer;
  digest: string;
  context: ImportContext;
  /** The destination folder as it really was, with links resolved. */
  realDirectory: string;
  target: string;
  expiresAt: number;
};

/** A preview is good for five minutes, and only one is held at a time. */
const PREVIEW_TTL_MS = 5 * 60_000;
let pending: PendingImport | null = null;

function assertPlainName(name: string): void {
  if (name !== basename(name)) throw new Error("That file name contains a path.");
  if (name === "." || name === ".." || name.includes("\0")) throw new Error("That isn't a file name.");
  if (!isModFileName(name)) {
    throw new Error("A mod is a .js, .mjs, .ts or .tsx file. Hidden files aren't mods.");
  }
}

/**
 * The mods folder as it really is. A folder that is itself a link is refused:
 * resolving it at preview and writing at confirm would let the link be swapped
 * in between, and `wx` only protects the final file name, not its parents.
 */
function resolveDestination(directory: string): string {
  mkdirSync(directory, { recursive: true });
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink()) {
    throw new Error("The runtime's mods folder is a link. Hearthside won't add a file through a link; add it to the real folder.");
  }
  if (!stats.isDirectory()) throw new Error("The runtime's mods folder isn't a folder.");
  return realpathSync(directory);
}

/**
 * Read a chosen file for review. Refuses a link rather than following one
 * (a link could point anywhere, and the copy would silently take its target),
 * anything that isn't a regular file, and anything too big to read through.
 */
export function previewModFile(from: string, context: ImportContext): ModImportPreview {
  const name = basename(from);
  assertPlainName(name);
  // One descriptor checks and reads, and refuses to follow a link.
  const read = readBoundedFile(from, MAX_IMPORT_BYTES);
  if (read.truncated || read.size > MAX_IMPORT_BYTES) {
    throw new Error(`That file is ${Math.round(read.size / 1024)} KB. Hearthside adds mod files up to ${MAX_IMPORT_BYTES / 1024} KB, so you can read the whole thing first.`);
  }
  if (read.bytes.includes(0)) throw new Error("That file isn't text, so it can't be reviewed before being added.");

  const realDirectory = resolveDestination(context.directory);
  const target = join(realDirectory, name);
  const token = randomUUID();
  pending = {
    token,
    from: resolve(from),
    name,
    content: read.bytes,
    digest: createHash("sha256").update(read.bytes).digest("hex"),
    context,
    realDirectory,
    target,
    expiresAt: Date.now() + PREVIEW_TTL_MS,
  };
  return {
    token,
    name,
    bytes: read.bytes.byteLength,
    source: read.bytes.toString("utf8"),
    from: resolve(from),
    target,
  };
}

/**
 * Install the previewed bytes. `current` is the context as it is now: if the
 * connection, account or runtime home moved on, or the mods folder no longer
 * resolves to the same real folder, nothing is written.
 */
export function confirmModImport(token: string, current: ImportContext): ModImportResult {
  const held = pending;
  if (!held || held.token !== token) {
    throw new Error("That mod file is no longer the one being added. Choose it again.");
  }
  // Spend the token whatever happens next: a refused confirmation must not
  // leave a token that a second attempt could use against a changed folder.
  pending = null;
  if (held.expiresAt < Date.now()) {
    throw new Error("The preview expired. Choose the mod file again.");
  }
  if (held.context.identity !== current.identity) {
    throw new Error("Hearthside reconnected, or changed which Letta folder it uses, since you chose that file. Choose it again.");
  }
  assertPlainName(held.name);

  // Resolve the destination again, now. A mods folder that has been replaced
  // by a link, or that now resolves somewhere else, fails closed.
  const realDirectory = resolveDestination(current.directory);
  if (realDirectory !== held.realDirectory) {
    throw new Error("The runtime's mods folder isn't where it was when you chose that file. Nothing was written.");
  }
  const target = join(realDirectory, basename(held.name));
  if (resolve(target) !== resolve(held.target)) throw new Error("That destination isn't the mods folder.");

  // What was reviewed is what is installed. The digest is recomputed from the
  // held bytes so a mutated buffer could not slip past either.
  if (createHash("sha256").update(held.content).digest("hex") !== held.digest) {
    throw new Error("The reviewed file could not be verified. Choose it again.");
  }
  try {
    // "wx" fails if anything is already there, including a link: no mod is
    // ever overwritten and nothing is removed to make room.
    writeFileSync(target, held.content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") {
      throw new Error(`There is already a ${held.name} in the mods folder. Hearthside won't replace it. Rename your file, or remove that one yourself first.`);
    }
    throw error;
  }
  return { name: held.name, path: target };
}

/**
 * Forget any held preview. Called on every change that could move where a file
 * would land: a reconnect, a different account, a different Letta folder, the
 * mods switch.
 */
export function forgetModImport(): void {
  pending = null;
}

/** Tests only. */
export function hasPendingModImport(): boolean {
  return pending !== null;
}
