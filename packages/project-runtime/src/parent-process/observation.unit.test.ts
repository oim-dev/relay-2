import { describe, expect, spyOn, test } from "bun:test";
import { nativeProcessLifetime } from "../native/process-lifetime/select";
import { observeParentProcess } from "./observation";
import type { ParentProcessObservation } from "./observation.types";

describe("Владение ресурсом наблюдения родителя", () => {
  test("повторный dispose освобождает native probe ровно один раз и не отменяет signal", () => {
    let releases = 0;
    const capture = spyOn(nativeProcessLifetime(), "captureParent").mockReturnValue({
      /**
       * Фиксирует живого родителя: этот тест проверяет владение probe, а не наблюдение ОС.
       */
      isAlive: (): boolean => true,
      /**
       * Считает освобождения единственного ресурса; настоящий native путь проверяется в integration.
       */
      dispose(): void {
        releases += 1;
      },
    });
    let observation: ParentProcessObservation | undefined;
    try {
      observation = observeParentProcess();

      observation.dispose();
      observation.dispose();

      expect(releases).toBe(1);
      expect(observation.signal.aborted).toBe(false);
    } finally {
      try {
        observation?.dispose();
      } finally {
        capture.mockRestore();
      }
    }
  });
});
