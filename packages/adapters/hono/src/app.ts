import type { PaywrapMpp } from "@zerorun/paywrap/mpp";
import { Hono } from "hono";
import type { PaywrapVariables } from "./gated.js";

/**
 * AppContext base shape. Consumers parameterize `T` with their full
 * context (env, db, services, ...). The adapter requires the mpp pieces
 * needed by `mppGated`; everything else is opaque.
 *
 * Unlike the fastify adapter we do NOT require a `logger` — Hono has no
 * built-in logger concept, and consumers on Workers typically log via
 * `console` / their own abstraction.
 */
export type AppContextBase = {
	mppx: PaywrapMpp["mppx"];
	mppxChannelStore: PaywrapMpp["channelStore"];
};

/**
 * Extra bindings we register on every Hono app built through this factory.
 * `paywrapApp` is the wiring the `mppGated` middleware reads to find
 * `ctx.mppx` + `ctx.mppxChannelStore` without the consumer having to
 * thread them through every route.
 */
export type PaywrapBindings = PaywrapVariables & {
	paywrapApp: { ctx: AppContextBase };
};

/**
 * Build a Hono instance preconfigured for a paywrap service:
 *
 *   - `paywrapApp` variable set on every request (read by `mppGated`).
 *   - `ctx` exposed on the app via a TypeScript-only property so consumers
 *     can reach it outside route handlers (e.g. shutdown hooks).
 *
 * Route registration stays in the consumer — keeping the adapter narrow
 * and letting consumers own their middleware order.
 *
 * Workers-safe: no Node-only imports, no top-level `process`/`Buffer`
 * usage, no filesystem access. The only transitive Node dependency comes
 * from the kit's AES-256-GCM crypto helpers (used only if you enable
 * `setup` features) and from `ioredis` (optional peer). The default
 * in-memory store path pulls in none of that.
 */
export const createHonoApp = <T extends AppContextBase>(
	ctx: T,
): Hono<{ Variables: PaywrapBindings }> & { ctx: T } => {
	const app = new Hono<{ Variables: PaywrapBindings }>();
	// Pre-middleware: expose the paywrap app shape so `mppGated` can reach
	// `ctx.mppx` + `ctx.mppxChannelStore` without a per-route wiring step.
	app.use("*", async (c, next) => {
		c.set("paywrapApp", { ctx });
		await next();
	});
	// Attach the raw ctx as a non-enumerable property so consumers that
	// need to reach (e.g.) a shutdown hook have a typed handle without
	// fishing it out of the middleware chain.
	return Object.assign(app, { ctx });
};
