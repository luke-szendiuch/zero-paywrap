/**
 * `paywrap check <url>` — hit `<url>/healthz` and `<url>/.well-known/paywrap.json`
 * and pretty-print each response. Non-fatal; we try both even if the first fails.
 */
export const runCheck = async (baseUrl: string): Promise<void> => {
	const base = baseUrl.replace(/\/$/, "");
	await probe(`${base}/healthz`, "HEALTHZ");
	await probe(`${base}/.well-known/paywrap.json`, "PAYWRAP.JSON");
};

const probe = async (url: string, label: string): Promise<void> => {
	process.stdout.write(`\n== ${label} (${url}) ==\n`);
	try {
		const res = await fetch(url);
		const text = await res.text();
		process.stdout.write(`status: ${res.status}\n`);
		try {
			const parsed = JSON.parse(text);
			process.stdout.write(`${JSON.stringify(parsed, null, 2)}\n`);
		} catch {
			process.stdout.write(`${text}\n`);
		}
	} catch (err) {
		process.stdout.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
	}
};
