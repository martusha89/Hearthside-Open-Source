

export function rowsToRetire(retired: readonly string[], finalKeys: ReadonlySet<string>, finishedWell: boolean): string[] {
  if (!finishedWell) return [];
  return [...new Set(retired)].filter((key) => !finalKeys.has(key));
}
