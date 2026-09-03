/**
 * Rebuild the practices index from the tree — boot, and after every store
 * mutation. The index is a cache; this is its one refresh path.
 */
import type { Practice } from "@rewter/shared";
import type { Repos } from "../db/repos.js";
import { type PracticeProblem, scanPracticesTree } from "./store.js";

export interface ReindexPracticesResult {
  practices: Practice[];
  /** Files the scanner refused — logged by the caller, never fatal. */
  problems: PracticeProblem[];
}

export function reindexPractices(root: string, repos: Repos): ReindexPracticesResult {
  const { practices, problems } = scanPracticesTree(root);
  repos.replacePracticesIndex(practices);
  return { practices, problems };
}
