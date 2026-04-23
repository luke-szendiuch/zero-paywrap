import { Store } from "mppx/server";

/** In-memory mppx channel store. Tests + local dev. Not durable. */
export const memoryStore = () => Store.memory();
