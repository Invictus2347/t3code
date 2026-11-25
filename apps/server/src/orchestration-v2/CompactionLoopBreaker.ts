import { CommandId, type OrchestrationV2DomainEvent, type RunId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";

// A model whose startup context (tool definitions, brief) overflows its window compacts,
// rereads, and compacts again forever, draining the user's plan. One or two compactions in
// a long run are normal; this many inside the window is a loop.
const COMPACTION_LOOP_LIMIT = 3;
const COMPACTION_LOOP_WINDOW_MS = 10 * 60 * 1000;

export const COMPACTION_LOOP_STOP_REASON = `Stopped: context compacted ${COMPACTION_LOOP_LIMIT} times in ${COMPACTION_LOOP_WINDOW_MS / 60_000} minutes. The model's context is likely full before it can work (too many startup tools or too large a brief).`;

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

export class CompactionLoopBreaker extends Context.Service<
  CompactionLoopBreaker,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/CompactionLoopBreaker") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  // Completed compaction item ids per live run, with when each completed.
  const compactionsByRun = new Map<RunId, Map<string, number>>();
  const tripped = new Set<RunId>();

  const handle: CompactionLoopBreaker["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type === "run.updated") {
        if (TERMINAL_RUN_STATUSES.has(event.payload.status)) {
          compactionsByRun.delete(event.payload.id);
          tripped.delete(event.payload.id);
        }
        return;
      }
      if (
        event.type !== "turn-item.updated" ||
        event.payload.type !== "compaction" ||
        event.payload.status !== "completed" ||
        event.payload.runId === null
      ) {
        return;
      }
      const runId = event.payload.runId;
      if (tripped.has(runId)) return;
      const at = DateTime.toEpochMillis(event.payload.completedAt ?? event.occurredAt);
      const compactions = compactionsByRun.get(runId) ?? new Map<string, number>();
      compactionsByRun.set(runId, compactions);
      if (!compactions.has(event.payload.id)) compactions.set(event.payload.id, at);
      for (const [itemId, completedAt] of compactions) {
        if (at - completedAt > COMPACTION_LOOP_WINDOW_MS) compactions.delete(itemId);
      }
      if (compactions.size < COMPACTION_LOOP_LIMIT) return;
      tripped.add(runId);
      compactionsByRun.delete(runId);
      yield* Effect.logWarning("compaction loop detected; interrupting run", {
        threadId: event.threadId,
        runId,
      });
      yield* engine.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`server:compaction-loop:${runId}`),
        threadId: event.threadId,
        runId,
        reason: COMPACTION_LOOP_STOP_REASON,
      });
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("interrupting a compaction loop failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: CompactionLoopBreaker["Service"]["start"] = Effect.fn("CompactionLoopBreaker.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, handle).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("compaction loop breaker event stream failed", { cause }),
          ),
        ),
      );
    },
  );

  return { start, handle } satisfies CompactionLoopBreaker["Service"];
});

export const layer = Layer.effect(CompactionLoopBreaker, make);
