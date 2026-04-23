import { Store } from "mppx/server";

/**
 * Build an in-memory mppx channel store. Useful for tests and local dev
 * without Redis. Not durable across restarts.
 */
export const memoryStore = () => Store.memory();
