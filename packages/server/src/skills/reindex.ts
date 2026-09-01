/**
 * Rebuild the skills index from the tree. Called at boot and after every
 * store mutation (approve/reject/distill land files, then reindex) — the
 * index is a cache and this is its one refresh path.
 */
import type { Skill } from "@rewter/shared";
import type { Repos } from "../db/repos.js";
import { type SkillProblem, scanSkillsTree } from "./store.js";

export interface ReindexResult {
  skills: Skill[];
  /** Files the scanner refused — logged by the caller, never fatal. */
  problems: SkillProblem[];
}

export function reindexSkills(root: string, repos: Repos): ReindexResult {
  const { skills, problems } = scanSkillsTree(root);
  repos.replaceSkillsIndex(skills);
  return { skills, problems };
}
