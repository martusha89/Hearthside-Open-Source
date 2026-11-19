import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';

// A parser test: never start Electron, read a profile, or write an import.
vi.mock('electron', () => ({ app: {} }));
import { detectSource, parseClaude } from '../src/main/libs/history-import';

it('preserves both speakers and their order in the synthetic archive', () => {
  const sample = JSON.parse(readFileSync(new URL('./synthetic-import.json', import.meta.url), 'utf8'));
  expect(detectSource(sample)).toBe('claude');
  const { conversations } = parseClaude(sample);
  expect(conversations).toHaveLength(1);
  expect(conversations[0]?.messages.map(({ speaker, text }) => [speaker, text])).toEqual([
    ['human', 'Name a shape with three sides.'],
    ['assistant', 'A triangle.'],
  ]);
});
