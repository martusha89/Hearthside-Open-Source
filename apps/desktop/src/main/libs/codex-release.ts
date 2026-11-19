/**
 * Hearthside: which official Codex download belongs to this computer.
 *
 * OpenAI publishes a self-contained package for each platform on the Codex
 * release page ("codex-package-<triple>.tar.gz": bin/codex, codex-resources,
 * codex-path), plus a checksum list covering exactly those files. Hearthside
 * pins one release and keeps that release's checksums here, in the app bundle,
 * so an install is checked against a number that shipped with Hearthside
 * rather than one fetched alongside the download.
 *
 * Nothing here touches the network or the disk: the version, the addresses and
 * the checksums are facts about a release, so they can be read in a test.
 *
 * Pinned from https://github.com/openai/codex/releases/tag/rust-v0.167.0 and
 * its codex-package_SHA256SUMS. To move the pin, take both the tag and every
 * checksum from the same release page.
 */

export const CODEX_VERSION = "0.167.0";
export const CODEX_RELEASE_TAG = "rust-v0.167.0";

/** The platforms OpenAI builds a Codex package for. */
export type CodexTriple =
  | "x86_64-pc-windows-msvc"
  | "aarch64-pc-windows-msvc"
  | "x86_64-apple-darwin"
  | "aarch64-apple-darwin"
  | "x86_64-unknown-linux-musl"
  | "aarch64-unknown-linux-musl";

/** SHA-256 of codex-package-<triple>.tar.gz, from the release's own checksum list. */
export const CODEX_PACKAGE_SHA256: Record<CodexTriple, string> = {
  "x86_64-pc-windows-msvc": "60567ca940bbaf6c10501805d9909d1328179231e2d47a0deec7a1368bb21641",
  "aarch64-pc-windows-msvc": "ba082050263022f460e065c061b2ee79682fb7f164fee8749e4420eb675a0932",
  "x86_64-apple-darwin": "3d7c4c83296db63b5108e13612c77f3e5020b6c5f2fc004bee413a5cc92de899",
  "aarch64-apple-darwin": "af45ed45d940d7998809622c1c0296d3098ed7d7fad695284422c228bd454517",
  "x86_64-unknown-linux-musl": "3bbf75e83de6b58aed28f2cf6e33ad423ec31fd4700a1457b94be557ea5a7c6e",
  "aarch64-unknown-linux-musl": "0de261ecf1e7f3028a7952f03fca2093f749277d38590b78bb32f8567756bbb7",
};

/**
 * The package for this computer, or null when OpenAI doesn't build one for it
 * (32-bit Windows, Linux on armv7, …). Null means Hearthside says so plainly
 * instead of downloading something that can't run.
 */
export function codexTriple(platform: string = process.platform, arch: string = process.arch): CodexTriple | null {
  const bitness = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  if (!bitness) return null;
  if (platform === "win32") return `${bitness}-pc-windows-msvc`;
  if (platform === "darwin") return `${bitness}-apple-darwin`;
  if (platform === "linux") return `${bitness}-unknown-linux-musl`;
  return null;
}

export function codexPackageName(triple: CodexTriple): string {
  return `codex-package-${triple}.tar.gz`;
}

export function codexPackageUrl(triple: CodexTriple): string {
  return `https://github.com/openai/codex/releases/download/${CODEX_RELEASE_TAG}/${codexPackageName(triple)}`;
}

/**
 * Hosts a Codex download may come from: the release page, and the storage
 * GitHub redirects release downloads to. Checked before asking for the file so
 * a mistake in the address above can't send the request somewhere else, and
 * again on the address the redirects ended at.
 */
const DOWNLOAD_HOSTS = new Set(["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);

export function isOfficialDownloadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && DOWNLOAD_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Where the program ends up inside the package (it extracts without a wrapping
 * folder). Named after the package being installed rather than the computer
 * doing the installing, so the two can never disagree.
 */
export function codexEntryPoint(triple: CodexTriple): string {
  return triple.includes("windows") ? "bin/codex.exe" : "bin/codex";
}
