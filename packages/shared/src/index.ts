export const REWTER_VERSION = "0.1.0";

/**
 * Cookie the daemon accepts as an `/internal` credential, equal in standing to
 * `Authorization: Bearer` and `x-api-key`. It exists for exactly one caller:
 * the dashboard bundle, whose `new WebSocket()` cannot carry a header but whose
 * browser sends cookies on the upgrade for free. `main.tsx` sets it from a
 * one-time `?key=` bootstrap; the server never sets it — a Set-Cookie from the
 * daemon would need path/expiry/SameSite opinions that belong to the browser
 * session, not the API.
 */
export const INTERNAL_KEY_COOKIE = "rewter_internal_key";

export * from "./ids.js";
export * from "./lifecycle.js";
export * from "./entities.js";
export * from "./events.js";
export * from "./projects.js";
export * from "./skills.js";
export * from "./fold.js";
export * from "./costs.js";
export * from "./registry.js";
export * from "./providers.js";
export * from "./health.js";
export * from "./socket.js";
export * from "./chat.js";
export * from "./openai.js";
export * from "./anthropic.js";
export * from "./translate.js";
export * from "./run.js";
export * from "./steer.js";
export * from "./shutdown.js";
export * from "./transfer.js";
