import {
  EventId,
  type OrchestrationV2DomainEvent,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as CompactionLoopBreaker from "./CompactionLoopBreaker.ts";
import * as Orchestrator from "./Orchestrator.ts";

const THREAD_ID = ThreadId.make("compaction-loop-thread");
const RUN_ID = RunId.make("compaction-loop-run");
const START = DateTime.makeUnsafe("2026-11-25T00:00:00.000Z");

const compacted = (index: number, minutesAfterStart: number): OrchestrationV2DomainEvent => {
  const at = DateTime.add(START, { minutes: minutesAfterStart });
  return {
    id: EventId.make(`compaction-loop-event-${index}`),
    type: "turn-item.updated",
    threadId: THREAD_ID,
    runId: RUN_ID,
    occurredAt: at,
    payload: {
      id: TurnItemId.make(`compaction-loop-item-${index}`),
      threadId: THREAD_ID,
      runId: RUN_ID,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: index,
      type: "compaction",
      driver: null,
      status: "completed",
      title: "Context compacted",
      startedAt: at,
      completedAt: at,
      updatedAt: at,
    },
  };
};

const runBreaker = Effect.fn("runCompactionLoopBreaker")(function* (
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
) {
  const dispatched = yield* Ref.make<
    ReadonlyArray<Parameters<Orchestrator.OrchestratorV2Shape["dispatch"]>[0]>
  >([]);
  const dispatch: Orchestrator.OrchestratorV2Shape["dispatch"] = (command) =>
    Ref.update(dispatched, (recorded) => [...recorded, command]).pipe(
      Effect.as({ sequence: 1, storedEvents: [] }),
    );
  yield* Effect.gen(function* () {
    const breaker = yield* CompactionLoopBreaker.CompactionLoopBreaker;
    for (const event of events) yield* breaker.handle(event);
  }).pipe(
    Effect.provide(
      CompactionLoopBreaker.layer.pipe(
        Layer.provide(Layer.mock(Orchestrator.OrchestratorV2)({ dispatch })),
      ),
    ),
  );
  return yield* Ref.get(dispatched);
});

describe("CompactionLoopBreaker", () => {
  it.effect("interrupts a run that compacts three times inside the window", () =>
    Effect.gen(function* () {
      const dispatched = yield* runBreaker([compacted(1, 0), compacted(2, 1), compacted(3, 2)]);
      assert.deepStrictEqual(
        dispatched.map((command) => command.type),
        ["run.interrupt"],
      );
      const [command] = dispatched;
      assert(command?.type === "run.interrupt");
      assert.strictEqual(command.runId, RUN_ID);
      assert.strictEqual(command.threadId, THREAD_ID);
      assert.strictEqual(command.reason, CompactionLoopBreaker.COMPACTION_LOOP_STOP_REASON);
    }),
  );

  it.effect("leaves a run with two compactions alone, even when one is reported twice", () =>
    Effect.gen(function* () {
      const dispatched = yield* runBreaker([compacted(1, 0), compacted(2, 1), compacted(2, 1)]);
      assert.deepStrictEqual(dispatched, []);
    }),
  );

  it.effect("leaves a run alone when three compactions span more than the window", () =>
    Effect.gen(function* () {
      const dispatched = yield* runBreaker([compacted(1, 0), compacted(2, 6), compacted(3, 11)]);
      assert.deepStrictEqual(dispatched, []);
    }),
  );
});
