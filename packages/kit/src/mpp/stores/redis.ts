import type IORedis from "ioredis";
import { Store } from "mppx/server";

type Change<value, result> = Store.Change<value, result>;

/**
 * Wrap an ioredis client as an mppx `AtomicStore` and return an mppx store.
 *
 * mppx's `Store.redis()` requires an atomic `update` callback because Tempo
 * session voucher accounting must be linearizable across workers. ioredis
 * doesn't ship a read-modify-write primitive, but WATCH/MULTI/EXEC gives us
 * one — if the key changes between WATCH and EXEC, EXEC returns null and we
 * retry.
 *
 * Use a dedicated Redis logical DB (passed via the `IORedis` constructor's
 * `db:` option) so mppx's channel keys don't collide with BullMQ's queue
 * keys. Keeping them separate makes it trivial to purge one without
 * touching the other during ops.
 */
export const redisStore = (redis: IORedis) => Store.redis(wrapIoredisForMppx(redis));

const MAX_RETRIES = 20;

export const wrapIoredisForMppx = (redis: IORedis) => ({
	async get(key: string) {
		return redis.get(key);
	},
	async set(key: string, value: string) {
		return redis.set(key, value);
	},
	async del(key: string) {
		return redis.del(key);
	},
	async update<result>(
		key: string,
		fn: (current: string | null) => Change<string, result>,
	): Promise<result> {
		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			await redis.watch(key);
			const current = await redis.get(key);
			const change = fn(current);

			if (change.op === "noop") {
				await redis.unwatch();
				return change.result;
			}

			const pipeline = redis.multi();
			if (change.op === "set") pipeline.set(key, change.value);
			else if (change.op === "delete") pipeline.del(key);

			const execResult = await pipeline.exec();
			if (execResult !== null) return change.result;
		}
		throw new Error(
			`paywrap/mpp: atomic update for key "${key}" failed after ${MAX_RETRIES} retries (too much contention)`,
		);
	},
});
