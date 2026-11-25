import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ServerProviderModel,
} from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

const COUNCIL_SKILL = "wayfinder-council";
const COUNCIL_CHILD_TITLE_PREFIX = "Council · ";
export const COUNCIL_WORKFLOWS = ["wayfinder", "prototype", "fusion", "spec", "handoff"] as const;
export type CouncilWorkflow = (typeof COUNCIL_WORKFLOWS)[number];

export interface CouncilSeat {
  readonly instanceId: string;
  readonly model: string;
  readonly effort: string | null;
}

export interface CouncilConfig {
  readonly workflow: CouncilWorkflow;
  readonly lead: CouncilSeat;
  readonly reviewers: ReadonlyArray<CouncilSeat>;
}

const DEFAULT_COUNCIL_CONFIG: CouncilConfig = {
  workflow: "wayfinder",
  lead: { instanceId: "claudeAgent", model: "claude-fable-5-2", effort: "medium" },
  reviewers: [
    { instanceId: "claudeAgent", model: "claude-opus-5-5", effort: "medium" },
    { instanceId: "antigravity", model: "gemini-4-neon", effort: "medium" },
    { instanceId: "codex", model: "gpt-6.2-astra", effort: "medium" },
  ],
};

export interface CouncilLaunchTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

/** Where the launch dialog starts the lead thread. The command palette closes as it runs, so the root renders the dialog. */
export const councilLaunchTargetAtom = Atom.make<CouncilLaunchTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("council:launch-target"),
);

export function openCouncilLaunchDialog(target: CouncilLaunchTarget): void {
  appAtomRegistry.set(councilLaunchTargetAtom, target);
}

export function closeCouncilLaunchDialog(): void {
  appAtomRegistry.set(councilLaunchTargetAtom, null);
}

const REASONING_OPTION_IDS = new Set([
  "effort",
  "reasoningEffort",
  "reasoning_effort",
  "thought_level",
]);

export interface EffortControl {
  readonly id: string;
  readonly choices: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly defaultId: string | null;
}

/** The model's reasoning-effort option, read from the live catalog. */
export function effortControlFor(model: ServerProviderModel | undefined): EffortControl | null {
  const descriptor = model?.capabilities?.optionDescriptors?.find(
    (option) =>
      option.type === "select" &&
      (option.role === "reasoning" || REASONING_OPTION_IDS.has(option.id)),
  );
  if (descriptor === undefined || descriptor.type !== "select") return null;
  return {
    id: descriptor.id,
    choices: descriptor.options.map((choice) => ({ id: choice.id, label: choice.label })),
    defaultId:
      descriptor.currentValue ??
      descriptor.options.find((choice) => choice.isDefault)?.id ??
      descriptor.options[0]?.id ??
      null,
  };
}

/** Keeps the wanted effort when the model offers it, otherwise the model's default. */
export function resolveEffort(control: EffortControl | null, wanted: string | null): string | null {
  if (control === null) return null;
  if (wanted !== null && control.choices.some((choice) => choice.id === wanted)) return wanted;
  return control.defaultId;
}

export function seatModelSelection(
  seat: CouncilSeat,
  control: EffortControl | null,
): ModelSelection {
  const effort = resolveEffort(control, seat.effort);
  return {
    instanceId: ProviderInstanceId.make(seat.instanceId),
    model: seat.model,
    ...(control !== null && effort !== null
      ? { options: [{ id: control.id, value: effort }] }
      : {}),
  };
}

function seatSpec(seat: CouncilSeat): string {
  return `${seat.instanceId}:${seat.model}${seat.effort ? `@${seat.effort}` : ""}`;
}

/** The lead's first message: the skill, its launch arguments, then the problem. */
export function councilLaunchMessage(config: CouncilConfig, problem: string): string {
  const reviewers = config.reviewers.map(seatSpec).join(",");
  return `$${COUNCIL_SKILL} workflow=${config.workflow} reviewers=${reviewers}\n\n${problem.trim()}`;
}

const STORAGE_KEY = "t3code:council:last-config";

function isSeat(value: unknown): value is CouncilSeat {
  if (typeof value !== "object" || value === null) return false;
  const seat = value as Record<string, unknown>;
  return (
    typeof seat.instanceId === "string" &&
    typeof seat.model === "string" &&
    (seat.effort === null || typeof seat.effort === "string")
  );
}

export function readSavedCouncilConfig(): CouncilConfig {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_COUNCIL_CONFIG;
    const parsed = JSON.parse(raw) as Partial<CouncilConfig>;
    if (
      !isSeat(parsed.lead) ||
      !Array.isArray(parsed.reviewers) ||
      !parsed.reviewers.every(isSeat) ||
      !COUNCIL_WORKFLOWS.includes(parsed.workflow as CouncilWorkflow)
    ) {
      return DEFAULT_COUNCIL_CONFIG;
    }
    return parsed as CouncilConfig;
  } catch {
    return DEFAULT_COUNCIL_CONFIG;
  }
}

export function saveCouncilConfig(config: CouncilConfig): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // Storage can be unavailable; the defaults still work.
  }
}

/** Reviewer threads the council skill names "Council · <seat> · <session>". */
export function councilSeatLabel(title: string): string | null {
  if (!title.startsWith(COUNCIL_CHILD_TITLE_PREFIX)) return null;
  return title.slice(COUNCIL_CHILD_TITLE_PREFIX.length).split(" · ")[0] ?? null;
}
