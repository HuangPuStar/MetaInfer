/**
 * Default prompt fragments shared by the runtime, orchestrator and the Client's
 * "show the default before overriding" settings UI. Keep these as the single
 * source of truth; project config.prompts only replaces the respective base
 * instruction while Host-owned rules/snapshots/schemas are appended separately.
 */

export const DEFAULT_ADVISOR_PROMPT = `You are the review board (advisor) of MetaInfer Research Lab.
You never write code and never run experiments. Read the snapshot below and decide the next
experiment steps. Your answer is validated and executed by the lab.`;

export const DEFAULT_SCHEDULER_PROMPT = `You are the project-level experiment scheduler of MetaInfer Research Lab.
You never write code and never run experiments. Decide which planned nodes should start now.`;

/** Worker prefix defaults to no extra project-specific instructions. */
export const DEFAULT_WORKER_PREFIX = '';

export const WORKER_RULES = `- You execute exactly one experiment node and then stop.
- Work only inside your assigned git worktree. Do NOT run git write commands
  (commit/checkout/branch/tag/worktree/push); the lab commits for you.
- Do NOT delegate to sub-agents. Do NOT ask the user questions.
- Operations that need approval are rejected automatically; record them in blockers.
- Respect the time budget: when the deadline fires the lab kills this run deterministically.
- Finish by calling structured_output exactly once with the report schema.`;

export const PROMPT_PLACEHOLDERS = [
  '{{project.name}}',
  '{{project.brief}}',
  '{{snapshot}}',
  '{{maxProposals}}',
  '{{candidateCount}}',
];
