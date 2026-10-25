import { describe, expectTypeOf, test } from "bun:test";
import type {
  HttpResponse,
  ServerContext,
  ProjectEntity,
  BatchResult,
  ImplementationData,
} from "@relay/contracts";
import type { ImplementationData as GeneratedImplementationData } from "../dist/generated/data-contracts";
import type { RelayGeneratedApi } from "./operations.types";

describe("Точность OpenAPI codegen", () => {
  test("контекст, карточка и квитанция сохраняют DTO вместо unresolved any", () => {
    expectTypeOf<Awaited<ReturnType<RelayGeneratedApi["context"]>>>().not.toBeAny();
    expectTypeOf<Awaited<ReturnType<RelayGeneratedApi["entity"]>>>().not.toBeAny();
    expectTypeOf<Awaited<ReturnType<RelayGeneratedApi["command"]>>>().not.toBeAny();
    expectTypeOf<Awaited<ReturnType<RelayGeneratedApi["context"]>>>().toMatchTypeOf<
      HttpResponse<ServerContext>
    >();
    expectTypeOf<Awaited<ReturnType<RelayGeneratedApi["entity"]>>>().toMatchTypeOf<
      HttpResponse<ProjectEntity>
    >();
    expectTypeOf<Awaited<ReturnType<RelayGeneratedApi["command"]>>>().toMatchTypeOf<
      HttpResponse<BatchResult>
    >();
  });

  test("generated command input сохраняет литеральный каталог действий", () => {
    expectTypeOf<Parameters<RelayGeneratedApi["command"]>[1]>().not.toBeAny();
    expectTypeOf<Parameters<RelayGeneratedApi["command"]>[1]["op"]>().not.toBeAny();
    expectTypeOf<Parameters<RelayGeneratedApi["command"]>[1]["op"]>().not.toEqualTypeOf<string>();
  });

  test("цель реализации сохраняет дискриминацию и запрет scenarioId у feature", () => {
    expectTypeOf<GeneratedImplementationData>().not.toBeAny();
    expectTypeOf<GeneratedImplementationData>().toMatchTypeOf<ImplementationData>();
    expectTypeOf<Extract<GeneratedImplementationData, { targetKind: "feature" }>>().not.toBeNever();
    expectTypeOf<
      Extract<GeneratedImplementationData, { targetKind: "scenario" }>
    >().not.toBeNever();
  });
});
