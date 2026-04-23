// Biome formats with tabs; 2-space JSON gets rewritten on first lint. Emit
// tabs directly so `pnpm lint` in the scaffold is clean on first run.
export const stringifyTabs = (value: unknown): string => JSON.stringify(value, null, "\t");
