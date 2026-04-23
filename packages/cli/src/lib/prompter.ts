import * as clack from "@clack/prompts";

/**
 * Tiny abstraction over @clack/prompts so tests can inject canned answers
 * without spinning up a TTY. The real implementation delegates; the test
 * implementation returns the values stored on a map keyed by prompt name.
 */
export type Prompter = {
	text: (opts: { name: string; message: string; defaultValue?: string }) => Promise<string>;
	select: <T extends string>(opts: {
		name: string;
		message: string;
		options: { value: T; label: string }[];
		defaultValue: T;
	}) => Promise<T>;
	confirm: (opts: { name: string; message: string; defaultValue?: boolean }) => Promise<boolean>;
};

export const makeClackPrompter = (): Prompter => ({
	text: async ({ message, defaultValue }) => {
		const result = await clack.text({
			message,
			...(defaultValue !== undefined ? { placeholder: defaultValue, defaultValue } : {}),
		});
		if (clack.isCancel(result)) {
			clack.cancel("Aborted.");
			process.exit(1);
		}
		return String(result);
	},
	select: async ({ message, options, defaultValue }) => {
		// biome-ignore lint/suspicious/noExplicitAny: clack's Option conditional distributes weirdly over a generic T
		const result = await clack.select<any>({
			message,
			options,
			initialValue: defaultValue,
		});
		if (clack.isCancel(result)) {
			clack.cancel("Aborted.");
			process.exit(1);
		}
		return result as typeof defaultValue;
	},
	confirm: async ({ message, defaultValue }) => {
		const result = await clack.confirm({
			message,
			initialValue: defaultValue ?? true,
		});
		if (clack.isCancel(result)) {
			clack.cancel("Aborted.");
			process.exit(1);
		}
		return Boolean(result);
	},
});

/**
 * Build a prompter from a precomputed answer map. Used by tests and the
 * `--yes` / `--non-interactive-defaults` flag (which fills the map with
 * defaults rather than asking anything).
 */
export const makeStubPrompter = (answers: Record<string, unknown>): Prompter => ({
	text: async ({ name, defaultValue }) => {
		if (name in answers) return String(answers[name]);
		if (defaultValue !== undefined) return defaultValue;
		throw new Error(`stub prompter: no answer for '${name}'`);
	},
	select: async ({ name, defaultValue }) => {
		// biome-ignore lint/suspicious/noExplicitAny: test stub hatch
		if (name in answers) return answers[name] as any;
		return defaultValue;
	},
	confirm: async ({ name, defaultValue }) => {
		if (name in answers) return Boolean(answers[name]);
		return defaultValue ?? true;
	},
});
