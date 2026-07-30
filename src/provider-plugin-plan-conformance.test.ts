import { describe, expect, test } from "bun:test";

import type {
  BrowserDispatchPlan,
  OperationInput,
  OperationRisk,
} from "./model";
import {
  MAX_PROVIDER_PLUGIN_PLAN_BYTES,
  runProviderPluginPlanConformance,
  type ProviderPluginPlanOperationV1,
} from "./provider-plugin";

type UnsafePlanner = (input: OperationInput) => unknown;

function operation(
  risk: OperationRisk,
  dispatch: ProviderPluginPlanOperationV1["dispatch"],
  planner: UnsafePlanner,
): ProviderPluginPlanOperationV1 {
  return {
    name: "records.publish",
    risk,
    dispatch,
    planDispatches: planner as (
      input: OperationInput,
    ) => readonly BrowserDispatchPlan[],
  };
}

function dispatch(id = "records.publish", description = "Publish one record"): {
  readonly id: string;
  readonly description: string;
} {
  return { id, description };
}

describe("provider plugin plan conformance", () => {
  test("passes separate deeply frozen input snapshots and returns detached frozen output", () => {
    const original: OperationInput = {
      actor: "account:viewer",
      items: [
        "first",
        { kind: "file", reference: "plan-file-reference" },
      ],
    };
    const observedInputs: OperationInput[] = [];
    const planned = runProviderPluginPlanConformance(
      operation("R2", "thread-items", (input) => {
        observedInputs.push(input);
        expect(Object.isFrozen(input)).toBeTrue();
        expect(Object.isFrozen(input.items)).toBeTrue();
        const items = input.items;
        if (!Array.isArray(items)) throw new Error("items disappeared");
        expect(Object.isFrozen(items[1])).toBeTrue();
        return [
          dispatch("records.publish[1]", "Publish record one"),
          dispatch("records.publish[2]", "Publish record two"),
        ];
      }),
      original,
    );

    expect(observedInputs).toHaveLength(2);
    expect(observedInputs[0]).not.toBe(original);
    expect(observedInputs[0]).not.toBe(observedInputs[1]);
    expect(observedInputs[0]?.items).not.toBe(original.items);
    expect(observedInputs[0]?.items).not.toBe(observedInputs[1]?.items);
    expect(original).toEqual({
      actor: "account:viewer",
      items: [
        "first",
        { kind: "file", reference: "plan-file-reference" },
      ],
    });
    expect(planned).toEqual([
      dispatch("records.publish[1]", "Publish record one"),
      dispatch("records.publish[2]", "Publish record two"),
    ]);
    expect(Object.isFrozen(planned)).toBeTrue();
    expect(planned.every(Object.isFrozen)).toBeTrue();
  });

  test("rejects malformed, extra, duplicate, accessor, and non-JSON values", () => {
    const accessor = {};
    let getterCalled = false;
    Object.defineProperties(accessor, {
      id: {
        enumerable: true,
        get: () => {
          getterCalled = true;
          return "records.publish";
        },
      },
      description: {
        enumerable: true,
        value: "Publish one record",
      },
    });
    const accessorArray = new Array<unknown>(1);
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get: () => {
        getterCalled = true;
        return dispatch();
      },
    });
    const cases: readonly {
      readonly label: string;
      readonly returned: unknown;
      readonly message: string;
    }[] = [
      {
        label: "non-array",
        returned: dispatch(),
        message: "plain JSON array",
      },
      {
        label: "sparse array",
        returned: new Array(1),
        message: "dense array",
      },
      {
        label: "array accessor",
        returned: accessorArray,
        message: "enumerable data property",
      },
      {
        label: "record accessor",
        returned: [accessor],
        message: "enumerable data property",
      },
      {
        label: "extra field",
        returned: [{ ...dispatch(), extra: true }],
        message: "only id and description",
      },
      {
        label: "malformed ID",
        returned: [dispatch("../escape")],
        message: "invalid dispatch ID",
      },
      {
        label: "duplicate ID",
        returned: [dispatch(), dispatch()],
        message: "duplicate dispatch ID",
      },
      {
        label: "non-JSON string",
        returned: [dispatch("records.publish", "\ud800")],
        message: "invalid description",
      },
    ];

    for (const candidate of cases) {
      expect(
        () => runProviderPluginPlanConformance(
          operation("R2", "single", () => candidate.returned),
          {},
        ),
        candidate.label,
      ).toThrow(candidate.message);
    }
    expect(getterCalled).toBeFalse();
  });

  test("enforces dispatch ceilings, canonical byte bounds, and risk/count laws", () => {
    expect(() => runProviderPluginPlanConformance(
      operation("R2", "thread-items", () =>
        Array.from({ length: 26 }, (_unused, index) =>
          dispatch(`records.publish[${index + 1}]`))),
      { items: Array.from({ length: 26 }, () => "item") },
    )).toThrow("at most 25 dispatches");

    const wideDescription = "界".repeat(500);
    expect(Buffer.byteLength(JSON.stringify(
      Array.from({ length: 25 }, (_unused, index) =>
        dispatch(`records.publish[${index + 1}]`, wideDescription)),
    ), "utf8")).toBeGreaterThan(MAX_PROVIDER_PLUGIN_PLAN_BYTES);
    expect(() => runProviderPluginPlanConformance(
      operation("R2", "thread-items", () =>
        Array.from({ length: 25 }, (_unused, index) =>
          dispatch(`records.publish[${index + 1}]`, wideDescription))),
      { items: Array.from({ length: 25 }, () => "item") },
    )).toThrow("canonical JSON bound");

    expect(() => runProviderPluginPlanConformance(
      operation("R1", "none", () => [dispatch()]),
      {},
    )).toThrow("R1 operations must not schedule remote dispatches");
    expect(() => runProviderPluginPlanConformance(
      operation("R2", "single", () => []),
      {},
    )).toThrow("at least one dispatch for R2");
    expect(() => runProviderPluginPlanConformance(
      operation("R2", "single", () => [
        dispatch("records.publish[1]"),
        dispatch("records.publish[2]"),
      ]),
      {},
    )).toThrow("exactly one dispatch");
    expect(() => runProviderPluginPlanConformance(
      operation("R3", "thread-items", () => [dispatch()]),
      { items: ["first", "second"] },
    )).toThrow("exactly one dispatch for each");
  });

  test("rejects a planner whose output changes for identical input", () => {
    let call = 0;
    expect(() => runProviderPluginPlanConformance(
      operation("R2", "single", () => {
        call += 1;
        return [dispatch(
          call === 1 ? "records.publish" : "records.publish-again",
        )];
      }),
      {},
    )).toThrow("unstable for identical input");
    expect(call).toBe(2);
  });
});
