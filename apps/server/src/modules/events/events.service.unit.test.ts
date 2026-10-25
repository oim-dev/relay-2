import { describe, expect, test } from "bun:test";
import { createEventStream } from "./events.service";
import type { EventSubscriber } from "./events.types";
import type { EventStreamFixture } from "./events.service.test.types";

/**
 * Создаёт consumer без фонового timer; тест управляет только событиями, abort и reader.
 * Возвращённый reader должен отменяться в finally, чтобы проверка не удерживала подписку при отказе.
 */
function subscription(generation = 10, abort = new AbortController()): EventStreamFixture {
  let subscriber: EventSubscriber | undefined;
  let unsubscriptions = 0;
  const stream = createEventStream("project", generation, abort.signal, (current) => {
    subscriber = current;
    return () => {
      unsubscriptions += 1;
    };
  });
  if (subscriber === undefined) {
    throw new Error("Stream должен синхронно присоединить consumer");
  }
  return {
    stream,
    subscriber,
    abort,
    /**
     * Наблюдает фактическое освобождение принадлежащей stream подписки.
     */
    unsubscribed: (): number => unsubscriptions,
  };
}

/**
 * Читает ровно один исходный SSE кадр; форма его payload проверяется независимым ожиданием теста.
 */
async function nextEvent(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<unknown> {
  const next = await reader.read();
  expect(next.done).toBe(false);
  const frame = new TextDecoder().decode(next.value);
  const data = frame.split("\n").find((line) => line.startsWith("data: "));
  if (data === undefined) {
    throw new Error("SSE кадр должен содержать JSON data");
  }
  return JSON.parse(data.slice(6));
}

describe("Bounded SSE invalidation consumer", () => {
  test("медленный consumer не задерживает и не объединяет события независимого быстрого reader", async () => {
    const slow = subscription();
    const fast = subscription();
    const slowReader = slow.stream.getReader();
    const fastReader = fast.stream.getReader();
    try {
      await nextEvent(fastReader);
      for (const generation of [11, 12, 13]) {
        const event = { type: "changed" as const, projectId: "project", generation };
        slow.subscriber.send(event);
        fast.subscriber.send(event);
        expect(await nextEvent(fastReader)).toEqual(event);
      }

      expect(await nextEvent(slowReader)).toEqual({
        type: "connected",
        projectId: "project",
        generation: 10,
      });
      expect(await nextEvent(slowReader)).toEqual({
        type: "changed",
        projectId: "project",
        generation: 13,
      });
    } finally {
      await slowReader.cancel();
      await fastReader.cancel();
    }
  });

  test("медленный reader получает initial connected и последнее поколение вместо всех промежуточных", async () => {
    const fixture = subscription();
    const reader = fixture.stream.getReader();
    try {
      fixture.subscriber.send({ type: "changed", projectId: "project", generation: 11 });
      fixture.subscriber.send({ type: "changed", projectId: "project", generation: 12 });
      fixture.subscriber.send({ type: "changed", projectId: "project", generation: 13 });
      fixture.subscriber.send({ type: "heartbeat", projectId: "project", generation: 13 });

      expect(await nextEvent(reader)).toEqual({
        type: "connected",
        projectId: "project",
        generation: 10,
      });
      expect(await nextEvent(reader)).toEqual({
        type: "changed",
        projectId: "project",
        generation: 13,
      });
      const waiting = reader.read();
      fixture.subscriber.stop();
      expect((await waiting).done).toBe(true);
      expect(fixture.unsubscribed()).toBe(1);
    } finally {
      await reader.cancel();
    }
  });

  test("повторные heartbeat занимают один слот и не остаются после последнего наблюдения", async () => {
    const fixture = subscription();
    const reader = fixture.stream.getReader();
    try {
      for (let tick = 0; tick < 5; tick += 1) {
        fixture.subscriber.send({ type: "heartbeat", projectId: "project", generation: 10 });
      }

      expect(await nextEvent(reader)).toEqual({
        type: "connected",
        projectId: "project",
        generation: 10,
      });
      expect(await nextEvent(reader)).toEqual({
        type: "heartbeat",
        projectId: "project",
        generation: 10,
      });
      const waiting = reader.read();
      fixture.subscriber.stop();
      expect((await waiting).done).toBe(true);
    } finally {
      await reader.cancel();
    }
  });

  test("последняя storage-error не маскируется heartbeat восстановления или более новым изменением", async () => {
    const fixture = subscription();
    const reader = fixture.stream.getReader();
    try {
      fixture.subscriber.send({ type: "changed", projectId: "project", generation: 11 });
      fixture.subscriber.send({
        type: "storage-error",
        projectId: "project",
        generation: 11,
        error: { code: "OLD", message: "Предыдущий отказ" },
      });
      fixture.subscriber.send({
        type: "storage-error",
        projectId: "project",
        generation: 11,
        error: { code: "CURRENT", message: "Последний отказ" },
      });
      fixture.subscriber.send({ type: "changed", projectId: "project", generation: 12 });
      fixture.subscriber.send({
        type: "storage-error",
        projectId: "project",
        generation: 12,
        error: { code: "LATEST", message: "Последний отказ чтения" },
      });
      fixture.subscriber.send({ type: "heartbeat", projectId: "project", generation: 12 });
      fixture.subscriber.send({ type: "heartbeat", projectId: "project", generation: 12 });

      expect(await nextEvent(reader)).toEqual({
        type: "connected",
        projectId: "project",
        generation: 10,
      });
      expect(await nextEvent(reader)).toEqual({
        type: "changed",
        projectId: "project",
        generation: 12,
      });
      expect(await nextEvent(reader)).toEqual({
        type: "storage-error",
        projectId: "project",
        generation: 12,
        error: { code: "LATEST", message: "Последний отказ чтения" },
      });
      expect(await nextEvent(reader)).toEqual({
        type: "heartbeat",
        projectId: "project",
        generation: 12,
      });
      const waiting = reader.read();
      fixture.subscriber.stop();
      expect((await waiting).done).toBe(true);
    } finally {
      await reader.cancel();
    }
  });

  test("изменение после ошибки сохраняет порядок: диагностика, затем последнее успешное поколение", async () => {
    const fixture = subscription();
    const reader = fixture.stream.getReader();
    try {
      fixture.subscriber.send({ type: "changed", projectId: "project", generation: 11 });
      fixture.subscriber.send({
        type: "storage-error",
        projectId: "project",
        generation: 11,
        error: { code: "READ_FAILED", message: "Отказ" },
      });
      fixture.subscriber.send({ type: "changed", projectId: "project", generation: 12 });

      await nextEvent(reader);
      expect(await nextEvent(reader)).toEqual({
        type: "storage-error",
        projectId: "project",
        generation: 11,
        error: { code: "READ_FAILED", message: "Отказ" },
      });
      expect(await nextEvent(reader)).toEqual({
        type: "changed",
        projectId: "project",
        generation: 12,
      });
    } finally {
      await reader.cancel();
    }
  });

  test("reconnect начинает новый connected, не наследуя очередь отменённого consumer", async () => {
    const previous = subscription();
    const before = previous.stream.getReader();
    try {
      await nextEvent(before);
      previous.subscriber.send({ type: "changed", projectId: "project", generation: 11 });
      previous.abort.abort();
      expect((await before.read()).done).toBe(true);
      expect(previous.unsubscribed()).toBe(1);
      const current = subscription(20);
      const after = current.stream.getReader();
      try {
        expect(await nextEvent(after)).toEqual({
          type: "connected",
          projectId: "project",
          generation: 20,
        });
        const waiting = nextEvent(after);
        current.subscriber.send({ type: "changed", projectId: "project", generation: 21 });
        expect(await waiting).toEqual({ type: "changed", projectId: "project", generation: 21 });
      } finally {
        await after.cancel();
      }
      expect(current.unsubscribed()).toBe(1);
    } finally {
      await before.cancel();
    }
  });

  test("abort до подключения освобождает подписку без connected и непрочитанной очереди", async () => {
    const abort = new AbortController();
    abort.abort();
    const fixture = subscription(10, abort);
    const reader = fixture.stream.getReader();
    try {
      expect((await reader.read()).done).toBe(true);
      fixture.subscriber.stop();
      expect(fixture.unsubscribed()).toBe(1);
    } finally {
      await reader.cancel();
    }
  });

  test.each(["cancel", "abort", "stop"] as const)(
    "%s освобождает подписку один раз и завершает ожидающий reader",
    async (action) => {
      const fixture = subscription();
      const reader = fixture.stream.getReader();
      try {
        await nextEvent(reader);
        const waiting = reader.read();
        if (action === "cancel") {
          await reader.cancel();
        } else if (action === "abort") {
          fixture.abort.abort();
        } else {
          fixture.subscriber.stop();
        }

        expect((await waiting).done).toBe(true);
        fixture.subscriber.stop();
        fixture.abort.abort();
        fixture.subscriber.send({ type: "changed", projectId: "project", generation: 99 });
        expect(fixture.unsubscribed()).toBe(1);
        expect((await reader.read()).done).toBe(true);
      } finally {
        await reader.cancel();
      }
    },
  );
});
