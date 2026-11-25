import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  OrchestrationV2ThreadShell,
  ScopedThreadRef,
  ServerProvider,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useGT } from "gt-react";

import { cn } from "~/lib/utils";
import { deriveProviderInstanceEntries } from "~/providerInstances";
import { useThreadRelationshipShells } from "~/state/entities";
import { useEnvironmentProviders } from "~/state/environments";
import { buildThreadRouteParams } from "~/threadRoutes";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { councilSeatLabel } from "./councilLaunch";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];
const ACTIVE_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const FAILED_STATUSES = new Set(["failed", "interrupted", "cancelled", "rolled_back"]);

/** Reviewer threads a council lead started, so the user can see and open each one. */
export function CouncilStrip({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const shells = useThreadRelationshipShells(threadRef);
  const seats = shells.filter(
    (shell) => shell.id !== threadRef.threadId && councilSeatLabel(shell.title) !== null,
  );
  if (seats.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-1.5">
      {seats.map((shell) => (
        <CouncilSeatChip key={shell.id} threadRef={threadRef} shell={shell} />
      ))}
    </div>
  );
}

function CouncilSeatChip(props: {
  readonly threadRef: ScopedThreadRef;
  readonly shell: OrchestrationV2ThreadShell;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const providersByEnvironment = useEnvironmentProviders();
  const providers = providersByEnvironment.get(props.threadRef.environmentId) ?? EMPTY_PROVIDERS;
  const entries = deriveProviderInstanceEntries(providers);
  const { shell } = props;
  const entry = entries.find((candidate) => candidate.instanceId === shell.providerInstanceId);
  const model = entry?.models.find((candidate) => candidate.slug === shell.modelSelection.model);
  const effort = shell.modelSelection.options?.find((option) =>
    ["effort", "reasoningEffort", "reasoning_effort", "thought_level"].includes(option.id),
  )?.value;
  const status = String(shell.status);
  const statusLabel = ACTIVE_STATUSES.has(status)
    ? gt("working")
    : FAILED_STATUSES.has(status)
      ? gt("stopped")
      : gt("done");
  return (
    <button
      type="button"
      aria-label={shell.title}
      className="flex items-center gap-1.5 rounded-full border border-border/70 bg-card px-2 py-0.5 text-xs hover:bg-accent"
      onClick={() =>
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(props.threadRef.environmentId, shell.id)),
        })
      }
    >
      {entry ? (
        <ProviderInstanceIcon
          driverKind={entry.driverKind}
          displayName={entry.displayName}
          accentColor={entry.accentColor}
          size="compact"
        />
      ) : null}
      <span className="font-medium">{councilSeatLabel(shell.title)}</span>
      <span className="text-muted-foreground">
        {model ? (model.shortName ?? model.name) : shell.modelSelection.model}
        {typeof effort === "string" ? ` · ${effort}` : ""}
      </span>
      <span
        aria-label={statusLabel}
        className={cn(
          "size-1.5 rounded-full",
          ACTIVE_STATUSES.has(status)
            ? "animate-pulse bg-warning"
            : FAILED_STATUSES.has(status)
              ? "bg-destructive"
              : "bg-success",
        )}
      />
    </button>
  );
}
