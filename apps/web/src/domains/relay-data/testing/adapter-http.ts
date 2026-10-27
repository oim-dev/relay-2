/// <reference types="bun" />
import type { BatchResult } from "@relay/contracts";

/**
 * Выполняет один adapter-сценарий через настоящий SDK, подменяя только Fetch.
 * Технический context возвращает фиксированного автора; остальные запросы принадлежат тесту.
 * Глобальный fetch восстановлен в finally. Helper предназначен для последовательных Bun tests,
 * не test.concurrent; отдельные worker-файлы имеют собственный globalThis.
 */
export async function withAdapterHttp<T>(
  respond: (request: Request) => Response | Promise<Response>,
  run: () => Promise<T>,
): Promise<{
  /* Результат вызванного адаптера, а не синтезированный результат fixture. */
  value: T;
  /* Независимые копии фактических Fetch-запросов в порядке отправки. */
  requests: readonly Request[];
}> {
  const original = globalThis.fetch;
  const requests: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request =
        input instanceof Request
          ? new Request(input, init)
          : new Request(new URL(String(input), "https://adapter.test"), init);
      requests.push(request.clone());
      if (new URL(request.url).pathname === "/api/v2/context") {
        return Response.json({
          ok: true,
          data: {
            actor: "Автор сервера",
            mode: "workspace",
            version: "test",
            projects: [],
          },
        });
      }
      return respond(request);
    },
    { preconnect: original.preconnect },
  );
  try {
    return { value: await run(), requests };
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * Возвращает подготовленную тестом квитанцию с фактическим operationKey запроса.
 * Не вычисляет эффект, ревизии или commands: ожидаемые payloads остаются в сценариях.
 * Любое неожиданное дополнительное чтение отвергается, а не подставляет свежую карточку.
 */
export async function batchResponse(
  request: Request,
  receipt: Omit<BatchResult, "operationKey">,
): Promise<Response> {
  if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/batch")) {
    throw new Error(`Неожиданный запрос адаптера: ${request.method} ${request.url}`);
  }
  const body: unknown = await request.json();
  if (
    !body ||
    typeof body !== "object" ||
    !("operationKey" in body) ||
    typeof body.operationKey !== "string"
  ) {
    throw new Error("SDK не передал operationKey");
  }
  return Response.json({ ok: true, data: { ...receipt, operationKey: body.operationKey } });
}
