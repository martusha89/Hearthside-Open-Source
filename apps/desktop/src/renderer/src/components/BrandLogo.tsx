import { BRAND_ICONS } from "../lib/brand-icons.data";

/** Hearthside: a service's logo (Simple Icons), or its first letter when we don't know it. */

const SLUGS = Object.keys(BRAND_ICONS).sort((a, b) => b.length - a.length);
const EXTRA: Record<string, string[]> = {
  elevenlabs: ["11labs", "eleven"],
  googlecalendar: ["gcal"],
  homeassistant: ["hass"],
  postgresql: ["postgres"],
};

function squash(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** The logo that fits a name, web address or command, if any. */
export function brandFor(...texts: Array<string | null | undefined>): string | null {
  const haystack = squash(texts.filter(Boolean).join(" "));
  if (!haystack) return null;
  for (const slug of SLUGS) {
    const names = [slug, squash(BRAND_ICONS[slug]!.title), ...(EXTRA[slug] ?? [])];
    // Short names ("git", "x") only count as a whole word, not inside another name.
    if (names.some((name) => (name.length >= 5 ? haystack.includes(name) : new RegExp(`(^|[^a-z0-9])${name}([^a-z0-9]|$)`).test(texts.join(" ").toLowerCase())))) return slug;
  }
  return null;
}

function isDark(hex: string): boolean {
  const value = Number.parseInt(hex, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b < 60;
}

export function BrandLogo({ brand, label, size = 32 }: { brand: string | null; label: string; size?: number }) {
  const icon = brand ? BRAND_ICONS[brand] : undefined;
  const box = { width: size, height: size };
  if (!icon) {
    return (
      <span aria-hidden className="flex shrink-0 items-center justify-center rounded-lg bg-surface-tertiary font-semibold text-ink-700" style={{ ...box, fontSize: size * 0.45 }}>
        {(label.trim()[0] ?? "?").toUpperCase()}
      </span>
    );
  }
  // Black logos would vanish in dark mode, so they follow the text colour.
  const dark = isDark(icon.hex);
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-lg bg-surface-tertiary"
      style={{ ...box, ...(dark ? {} : { backgroundColor: `#${icon.hex}1f` }) }}
      title={icon.title}
    >
      <svg viewBox="0 0 24 24" width={size * 0.58} height={size * 0.58} role="img" aria-label={icon.title} className={dark ? "text-ink-900" : undefined}>
        <path d={icon.path} fill={dark ? "currentColor" : `#${icon.hex}`} />
      </svg>
    </span>
  );
}
