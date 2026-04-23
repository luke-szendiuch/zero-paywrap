/**
 * Biome's default formatter uses tabs, so writing JSON.stringify(..., 2)
 * produces files the generated project's own lint step immediately
 * reformats. Emit tabs directly so `pnpm lint` in the scaffold is clean on
 * the first run.
 */
export const stringifyTabs = (value: unknown): string => JSON.stringify(value, null, "\t");
