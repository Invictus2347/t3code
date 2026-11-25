import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { DEFAULT_RUNTIME_MODE, type ServerProvider } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { newMessageId, newThreadId } from "~/lib/utils";
import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
  type ProviderInstanceEntry,
} from "~/providerInstances";
import { useEnvironmentProviders } from "~/state/environments";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { DEFAULT_INTERACTION_MODE } from "~/types";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  closeCouncilLaunchDialog,
  COUNCIL_WORKFLOWS,
  councilLaunchMessage,
  councilLaunchTargetAtom,
  type CouncilConfig,
  type CouncilLaunchTarget,
  type CouncilSeat,
  type CouncilWorkflow,
  effortControlFor,
  readSavedCouncilConfig,
  resolveEffort,
  saveCouncilConfig,
  seatModelSelection,
} from "./councilLaunch";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

export function CouncilLaunchDialogHost() {
  const target = useAtomValue(councilLaunchTargetAtom);
  if (target === null) return null;
  return (
    <CouncilLaunchDialog key={`${target.environmentId}:${target.projectId}`} target={target} />
  );
}

function seatKey(seat: Pick<CouncilSeat, "instanceId" | "model">): string {
  return `${seat.instanceId}\u0000${seat.model}`;
}

function CouncilLaunchDialog({ target }: { readonly target: CouncilLaunchTarget }) {
  const gt = useGT();
  const navigate = useNavigate();
  const providersByEnvironment = useEnvironmentProviders();
  const providers = providersByEnvironment.get(target.environmentId) ?? EMPTY_PROVIDERS;
  const entries = deriveProviderInstanceEntries(providers).filter(isProviderInstancePickerReady);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [config, setConfig] = useState<CouncilConfig>(readSavedCouncilConfig);
  const [problem, setProblem] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const findModel = (seat: CouncilSeat) =>
    entries
      .find((entry) => entry.instanceId === seat.instanceId)
      ?.models.find((model) => model.slug === seat.model);
  const unavailable = [config.lead, ...config.reviewers].filter(
    (seat) => findModel(seat) === undefined,
  );
  const canStart =
    !starting &&
    problem.trim().length > 0 &&
    config.reviewers.length > 0 &&
    findModel(config.lead) !== undefined;

  const start = async () => {
    if (!canStart) return;
    setStarting(true);
    setError(null);
    const normalize = (seat: CouncilSeat): CouncilSeat => ({
      ...seat,
      effort: resolveEffort(effortControlFor(findModel(seat)), seat.effort) ?? seat.effort,
    });
    const launched: CouncilConfig = {
      ...config,
      lead: normalize(config.lead),
      reviewers: config.reviewers.map(normalize),
    };
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    const modelSelection = seatModelSelection(
      config.lead,
      effortControlFor(findModel(config.lead)),
    );
    const title = gt("Council: {problem}", {
      problem: problem.trim().split("\n")[0]!.slice(0, 60),
    });
    const result = await startTurn({
      environmentId: target.environmentId,
      input: {
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          attachments: [],
          text: councilLaunchMessage(launched, problem),
        },
        modelSelection,
        titleSeed: title,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_INTERACTION_MODE,
        bootstrap: {
          createThread: {
            projectId: target.projectId,
            title,
            modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt,
          },
        },
        createdAt,
      },
    });
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : gt("Could not start the council."));
      setStarting(false);
      return;
    }
    saveCouncilConfig(launched);
    closeCouncilLaunchDialog();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(target.environmentId, threadId)),
    });
  };

  const updateReviewer = (index: number, seat: CouncilSeat) =>
    setConfig((current) => ({
      ...current,
      reviewers: current.reviewers.map((existing, i) => (i === index ? seat : existing)),
    }));

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !starting) closeCouncilLaunchDialog();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            <T>Start council</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              The lead sends one brief to every reviewer, reads their full work in their own
              threads, and makes the call. You can change the team later in the chat.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <Textarea
              autoFocus
              aria-label={gt("Problem")}
              placeholder={gt("What should the council work on?")}
              value={problem}
              rows={5}
              onChange={(event) => setProblem(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void start();
              }}
            />
            <div className="grid grid-cols-[6rem_1fr] items-center gap-x-3 gap-y-2 text-sm">
              <span className="text-muted-foreground">
                <T>Workflow</T>
              </span>
              <Select
                value={config.workflow}
                onValueChange={(value) => {
                  if (typeof value !== "string") return;
                  setConfig((current) => ({ ...current, workflow: value as CouncilWorkflow }));
                }}
              >
                <SelectTrigger size="sm" aria-label={gt("Workflow")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {COUNCIL_WORKFLOWS.map((workflow) => (
                    <SelectItem key={workflow} value={workflow}>
                      {workflow}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <span className="text-muted-foreground">
                <T>Lead</T>
              </span>
              <SeatPicker
                entries={entries}
                seat={config.lead}
                label={gt("Lead model")}
                onChange={(lead) => setConfig((current) => ({ ...current, lead }))}
              />
              {config.reviewers.map((seat, index) => (
                <ReviewerRow
                  // Seats can repeat, so the position is the identity.
                  // oxlint-disable-next-line no-array-index-key
                  key={index}
                  index={index}
                  entries={entries}
                  seat={seat}
                  onChange={(next) => updateReviewer(index, next)}
                  onRemove={() =>
                    setConfig((current) => ({
                      ...current,
                      reviewers: current.reviewers.filter((_, i) => i !== index),
                    }))
                  }
                />
              ))}
              <span />
              <div>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() =>
                    setConfig((current) => ({
                      ...current,
                      reviewers: [...current.reviewers, current.reviewers.at(-1) ?? current.lead],
                    }))
                  }
                >
                  <PlusIcon />
                  <T>Add reviewer</T>
                </Button>
              </div>
            </div>
            {unavailable.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {gt(
                  "Not offered here right now: {models}. The lead will name them as unavailable.",
                  {
                    models: unavailable.map((seat) => seat.model).join(", "),
                  },
                )}
              </p>
            ) : null}
            {error !== null ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={starting} onClick={closeCouncilLaunchDialog}>
            <T>Cancel</T>
          </Button>
          <Button disabled={!canStart} onClick={() => void start()}>
            {starting ? <T>Starting…</T> : <T>Start council</T>}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ReviewerRow(props: {
  readonly index: number;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly seat: CouncilSeat;
  readonly onChange: (seat: CouncilSeat) => void;
  readonly onRemove: () => void;
}) {
  const gt = useGT();
  return (
    <>
      <span className="text-muted-foreground">{gt("Reviewer {n}", { n: props.index + 1 })}</span>
      <div className="flex items-center gap-1">
        <SeatPicker
          entries={props.entries}
          seat={props.seat}
          label={gt("Reviewer {n} model", { n: props.index + 1 })}
          onChange={props.onChange}
        />
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={gt("Remove reviewer {n}", { n: props.index + 1 })}
          onClick={props.onRemove}
        >
          <XIcon />
        </Button>
      </div>
    </>
  );
}

function SeatPicker(props: {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly seat: CouncilSeat;
  readonly label: string;
  readonly onChange: (seat: CouncilSeat) => void;
}) {
  const gt = useGT();
  const { entries, seat } = props;
  const entry = entries.find((candidate) => candidate.instanceId === seat.instanceId);
  const model = entry?.models.find((candidate) => candidate.slug === seat.model);
  const effort = effortControlFor(model);
  const options = entries.flatMap((candidate) =>
    candidate.models
      .filter((option) => option.isLegacy !== true)
      .map((option) => ({ entry: candidate, model: option })),
  );
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <Select
        value={seatKey(seat)}
        onValueChange={(value) => {
          if (typeof value !== "string") return;
          const picked = options.find(
            (option) =>
              seatKey({ instanceId: option.entry.instanceId, model: option.model.slug }) === value,
          );
          if (picked === undefined) return;
          props.onChange({
            instanceId: picked.entry.instanceId,
            model: picked.model.slug,
            effort: resolveEffort(effortControlFor(picked.model), seat.effort),
          });
        }}
      >
        <SelectTrigger size="sm" className="min-w-0 flex-1" aria-label={props.label}>
          <SelectValue>
            {() => (
              <span className="flex min-w-0 items-center gap-1.5">
                {entry ? (
                  <ProviderInstanceIcon
                    driverKind={entry.driverKind}
                    displayName={entry.displayName}
                    accentColor={entry.accentColor}
                    size="compact"
                  />
                ) : null}
                <span className="truncate">
                  {model
                    ? (model.shortName ?? model.name)
                    : gt("{model} (unavailable)", { model: seat.model })}
                </span>
              </span>
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {options.map((option) => (
            <SelectItem
              key={seatKey({ instanceId: option.entry.instanceId, model: option.model.slug })}
              value={seatKey({ instanceId: option.entry.instanceId, model: option.model.slug })}
            >
              <span className="flex items-center gap-1.5">
                <ProviderInstanceIcon
                  driverKind={option.entry.driverKind}
                  displayName={option.entry.displayName}
                  accentColor={option.entry.accentColor}
                  size="compact"
                />
                {option.model.name}
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {effort !== null ? (
        <Select
          value={resolveEffort(effort, seat.effort) ?? ""}
          onValueChange={(value) => {
            if (typeof value !== "string") return;
            props.onChange({ ...seat, effort: value });
          }}
        >
          <SelectTrigger size="sm" className="w-28 shrink-0" aria-label={gt("Effort")}>
            <SelectValue>
              {(value: string) =>
                effort.choices.find((choice) => choice.id === value)?.label ?? value
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {effort.choices.map((choice) => (
              <SelectItem key={choice.id} value={choice.id}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}
    </div>
  );
}
