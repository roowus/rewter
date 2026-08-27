import { REWTER_VERSION } from "@rewter/shared";

export { openDb, type Db } from "./db/connection.js";
export * as schema from "./db/schema.js";
export { Repos } from "./db/repos.js";
export { EventBus, type EventListener } from "./events/bus.js";

export const SERVER_VERSION = REWTER_VERSION;
