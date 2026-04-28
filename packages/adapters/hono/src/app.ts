import type { LoggerCallback } from "@zeroclickai/paywrap/logger";
import type { PaywrapMpp } from "@zeroclickai/paywrap/mpp";
import { type Context, Hono } from "hono";
import type { PaywrapVariables } from "./gated.js";

/**
 * AppContext base. Consumers parameterize `T` with their full context. Unlike
 * the fastify adapter we do NOT require a `logger` — Hono has no built-in
 * logger and Workers consumers typically log via `console`.
 *
 * `paywrapLogger` is optional structured-event logging consumed by
 * `mppGated` / `x402Gated` middlewares. Wire it via `createPaywrapMpp({logger})`
 * or `createPaywrapX402({logger})` and surface it on this context.
 */
export type AppContextBase = {
	mppx: PaywrapMpp["mppx"];
	mppxChannelStore: PaywrapMpp["channelStore"];
	paywrapLogger?: LoggerCallback;
};

/** Variables the `mppGated` middleware reads off each request. */
export type PaywrapBindings = PaywrapVariables & {
	paywrapApp: { ctx: AppContextBase };
};

/**
 * Factory form. Workers env bindings (`c.env.*`) are only per-request, so
 * the ctx cannot be built at module load — pass a function that builds it
 * from the Hono Context.
 */
export type AppContextFactory<T extends AppContextBase> = (
	// biome-ignore lint/suspicious/noExplicitAny: consumer Hono types are opaque to the adapter
	c: Context<any, any, any>,
) => T | Promise<T>;

/**
 * Build a Hono app preconfigured for paywrap. `paywrapApp` is set on every
 * request (read by `mppGated`). Two shapes:
 *
 *   1. Fixed ctx (Node): `createHonoApp({ mppx, mppxChannelStore })` — same
 *      ctx per request. Attaches `.ctx` to the returned app for reach from
 *      outside routes (shutdown hooks).
 *   2. Factory ctx (Workers): `createHonoApp((c) => ({ ... }))` — factory
 *      runs per request so it can read `c.env.*`. No `.ctx` on the app.
 *
 * Workers-safe: no Node-only imports. The kit's AES-GCM and optional
 * ioredis only load if you use them.
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
		app.use("*", async (c, next) => {
			const ctx = await factory(c);
			c.set("paywrapApp", { ctx });
			await next();
		});
		return app;
	}
	const ctx = ctxOrFactory;
	app.use("*", async (c, next) => {
		c.set("paywrapApp", { ctx });
		await next();
	});
	return Object.assign(app, { ctx });
}
