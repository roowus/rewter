/**
 * The `?key=` bootstrap for a daemon whose `/internal` wants a key.
 *
 * A dashboard served off a non-loopback bind (the direct-bind tailscale mode)
 * gets its static bundle for free — `/` is not `/internal/` — but every fetch
 * and the WebSocket upgrade will 401 without a credential. Headers are not an
 * option for `new WebSocket()`, so the credential rides a cookie instead, and
 * this module is the only place that writes it: visit
 * `http://<host>:<port>/?key=<the key>` once, the key moves into the cookie,
 * and the URL is scrubbed so the secret never sits in the address bar, browser
 * history, or a screenshot.
 *
 * Behind `tailscale serve` (the recommended mode) none of this runs: the daemon
 * is loopback-bound, no key is configured, and a `?key=` was never handed out.
 */
import { INTERNAL_KEY_COOKIE } from "@rewter/shared";

export function bootstrapInternalKey(win: Pick<Window, "location" | "history"> = window): void {
  const params = new URLSearchParams(win.location.search);
  const key = params.get("key");
  if (key === null || key === "") return;

  // Session cookie, path-wide, SameSite=Strict: the key must ride same-origin
  // fetches and the WS upgrade, and nothing else. No Secure flag — the direct
  // bind is plain http on a tailnet, where Tailscale is the transport security.
  document.cookie = `${INTERNAL_KEY_COOKIE}=${encodeURIComponent(key)}; path=/; SameSite=Strict`;

  params.delete("key");
  const rest = params.toString();
  const clean = `${win.location.pathname}${rest === "" ? "" : `?${rest}`}${win.location.hash}`;
  // replaceState, not a redirect: the page keeps loading, and the history entry
  // holding the key is overwritten rather than left one Back-press away.
  win.history.replaceState(null, "", clean);
}
