/**
 * Utilities specific to Fastify-on-Node consumers.
 *
 * Why this lives in the adapter, not the kit: it uses Node-only Buffer
 * APIs (`allocUnsafeSlow` is not in Workers / Web standards). The kit
 * stays runtime-agnostic.
 */

/**
 * Copy a Fastify-managed Buffer (e.g. one returned by a content-type
 * parser like `@fastify/multipart` or `addContentTypeParser({parseAs: "buffer"})`)
 * into a fresh, standalone Node Buffer that does NOT share its underlying
 * ArrayBuffer with Fastify's pool.
 *
 * Why this exists: Fastify's parsers return Buffers backed by a shared
 * pool (observed: a 206-byte zip arrives at byteOffset=520 of an 8192-byte
 * pool). When a route handler does fire-and-forget work after the reply
 *
 *   reply.status(202).send(...)
 *   setImmediate(() => upstreamUpload(req.body))   // captures pooled view
 *
 * Fastify can recycle that pool slot for the next request before
 * `setImmediate` fires. The fire-and-forget then ships the wrong bytes.
 *
 * Symptom in production (paywrap netlify integration, 2026-04-24):
 * Netlify's deploy API received the buyer's zip with a different sha256
 * than the buyer sent. The deploy went "ready" with an empty file_tree
 * and served 404. Charge-intent had already settled; refund-trail-only.
 *
 * Fix is one line, but the diagnosis took an hour. Prefer this helper
 * over hand-rolling `Buffer.from(buf)` (which itself uses the pool for
 * small allocations) or `Uint8Array.from(buf)` (loses the Buffer type).
 *
 * @example
 *   reply.status(202).send({ ok: true });
 *   const safeCopy = defensiveBufferCopy(req.body as Buffer);
 *   setImmediate(() => upstream.upload(safeCopy));
 */
export const defensiveBufferCopy = (source: Buffer | Uint8Array): Buffer => {
	// allocUnsafeSlow bypasses Buffer.poolSize and gives us a standalone
	// allocation that Fastify's pool cannot recycle.
	const out = Buffer.allocUnsafeSlow(source.byteLength);
	if (Buffer.isBuffer(source)) {
		source.copy(out);
	} else {
		out.set(source);
	}
	return out;
};
