/**
 * "Could a task run right now?" — a judgement, not another row of counts.
 *
 * The health strip already reports `2/8 providers · 3/180 models · 41 cards`.
 * Those are facts, and reading a verdict off them is work the user should not
 * have to do: `0/8 providers` and `2/8 providers` are the same shape of fact and
 * completely different situations, and only one of them means the next task
 * fails. This turns the same numbers into the two things worth knowing — whether
 * anything is blocking, and the command that unblocks it.
 *
 * The distinction that carries the design is **blocked vs degraded**. With no
 * enabled model there is nothing to route to and the orchestrator cannot start.
 * With no capability cards it starts fine and picks badly: the digest is a list
 * of names and prices, so the initiator has nothing to prefer a vision model
 * *for*. Collapsing those into one "not ready" would either cry wolf about a
 * working daemon or stay quiet about a broken one.
 *
 * Nothing here probes anything. A card on the landing view that fired 75
 * outbound requests to render would be a page you learn not to open, and the
 * per-provider Test button already answers "is this key good" on demand.
 */
import type { DaemonHealth } from "@rewter/shared";

/** `blocked` = a task cannot run. `warn` = it runs worse than it should. */
export type ReadinessLevel = "ok" | "warn" | "blocked";

export interface ReadinessCheck {
  id: "providers" | "models" | "cards";
  level: ReadinessLevel;
  /** The state, in the user's terms. */
  label: string;
  /** What to do about it — `null` when there is nothing to do. */
  fix: string | null;
}

export interface Readiness {
  /** No blocked check. A `warn` is still ready; that is the whole distinction. */
  ready: boolean;
  checks: ReadinessCheck[];
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export function readinessOf(health: DaemonHealth): Readiness {
  const { providersEnabled, providersTotal, modelsEnabled, modelsTotal, cards } = health.registry;
  const checks: ReadinessCheck[] = [];

  checks.push(
    providersEnabled === 0
      ? {
          id: "providers",
          level: "blocked",
          label:
            providersTotal === 0
              ? "no providers configured"
              : `all ${providersTotal} providers are switched off`,
          fix: "rewter sync-models --preset <name>",
        }
      : {
          id: "providers",
          level: "ok",
          label: `${providersEnabled} of ${plural(providersTotal, "provider")} enabled`,
          fix: null,
        },
  );

  checks.push(
    modelsEnabled === 0
      ? {
          id: "models",
          level: "blocked",
          // Two different problems wearing one number: an empty registry needs a
          // sync, a full one that is entirely switched off needs the editor.
          label:
            modelsTotal === 0
              ? "no models in the registry"
              : `all ${modelsTotal} models are switched off`,
          fix: modelsTotal === 0 ? "rewter sync-models" : "enable one in the registry above",
        }
      : {
          id: "models",
          level: "ok",
          label: `${modelsEnabled} of ${plural(modelsTotal, "model")} enabled`,
          fix: null,
        },
  );

  // Only the zero case is flagged. `cards` counts cards across the whole
  // registry and `modelsEnabled` counts enabled models, so "how many enabled
  // models have a card" is not a number this payload can answer — and a
  // ratio between two different populations would read as one that is.
  checks.push(
    cards === 0
      ? {
          id: "cards",
          level: "warn",
          label: "no capability cards — the initiator picks on price alone",
          fix: "rewter card <model>",
        }
      : {
          id: "cards",
          level: "ok",
          label: `${plural(cards, "capability card")}`,
          fix: null,
        },
  );

  return { ready: !checks.some((check) => check.level === "blocked"), checks };
}
