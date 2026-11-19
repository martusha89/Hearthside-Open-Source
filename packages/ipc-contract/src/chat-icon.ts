/** A chosen symbol, not a title, URL, markup or invisible control sequence. */
export function validChatIcon(value: string): boolean {
  if (!value || value.length > 64 || /[\p{Cc}\p{Z}\p{Cs}<>\u202a-\u202e\u2066-\u2069]/u.test(value)) return false;
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)].length === 1 &&
    /[\p{Extended_Pictographic}\p{S}\p{Regional_Indicator}\u20e3]/u.test(value);
}
