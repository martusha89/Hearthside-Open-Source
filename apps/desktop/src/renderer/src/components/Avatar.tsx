import { initialColour, initialOf } from "../lib/looks";

/** Hearthside: a round picture, or a lettered circle when there is none. */
export function Avatar({ name, src, px = 28, className = "" }: { name: string; src: string | null | undefined; px?: number; className?: string }) {
  const style = { width: px, height: px, fontSize: Math.round(px * 0.45) };
  if (src) {
    return <img src={src} alt={`Picture of ${name}`} style={style} className={`shrink-0 rounded-full object-cover ${className}`} draggable={false} />;
  }
  return (
    <span
      aria-hidden
      style={{ ...style, backgroundColor: initialColour(name) }}
      className={`flex shrink-0 select-none items-center justify-center rounded-full font-semibold leading-none text-white ${className}`}
    >
      {initialOf(name)}
    </span>
  );
}
