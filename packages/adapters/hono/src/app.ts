import type { PaywrapMpp } from "@zerorun/paywrap/mpp";
import { type Context, Hono } from "hono";
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
 * Factory form of the ctx. Workers env bindings (`c.env.*`) are only
 * available per request, so the ctx can't be constructed at module load;
 * pass a function that builds it from the Hono Context instead.
 */
export type AppContextFactory<T extends AppContextBase> = (
	// biome-ignore lint/suspicious/noExplicitAny: consumer Hono types are opaque to the adapter
	c: Context<any, any, any>,
) => T | Promise<T>;

/**
 * Build a Hono instance preconfigured for a paywrap service:
 *
 *   - `paywrapApp` variable set on every request (read by `mppGated`).
 *   - `ctx` exposed on the app via a TypeScript-only property (fixed-ctx
 *     variant only) so consumers can reach it outside route handlers
 *     (e.g. shutdown hooks).
 *
 * Two shapes:
 *
 *   1. Fixed ctx (Node-style): `createHonoApp({ mppx, mppxChannelStore })`
 *      — the ctx is known at module load, used for every request.
 *
 *   2. Factory ctx (Workers-style): `createHonoApp((c) => ({ ... }))`
 *      — the factory runs per request with `c` in scope, so it can read
 *      `c.env.*` for KV/secrets and construct `createPaywrapMpp` inline.
 *      The ctx is NOT attached to the app — each request has its own.
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
export function createHonoApp<T extends AppContextBase>(
	ctx: T,
): Hono<{ Variables: PaywrapBindings }> & { ctx: T };
export function createHonoApp<T extends AppContextBase>(
	factory: AppContextFactory<T>,
): Hono<{ Variables: PaywrapBindings }>;
export function createHonoApp<T extends AppContextBase>(
	ctxOrFactory: T | AppContextFactory<T>,
): Hono<{ Variables: PaywrapBindings }> & { ctx?: T } {
	const app = new Hono<{ Variables: PaywrapBindings }>();
	if (typeof ctxOrFactory === "function") {
		const factory = ctxOrFactory as AppContextFactory<T>;
		// Per-request wiring. The factory gets the live Hono Context so it
		// can reach `c.env.*` (Workers bindings). Resolved ctx is set on
		// this request only.
		app.use("*", async (c, next) => {
			const ctx = await factory(c);
			c.set("paywrapApp", { ctx });
			await next();
		});
		// No `.ctx` — there isn't one; it's per-request.
		return app;
	}
	const ctx = ctxOrFactory;
	app.use("*", async (c, next) => {
		c.set("paywrapApp", { ctx });
		await next();
	});
	// Attach the raw ctx as a non-enumerable property so consumers that
	// need to reach (e.g.) a shutdown hook have a typed handle without
	// fishing it out of the middleware chain.
	return Object.assign(app, { ctx });
}
