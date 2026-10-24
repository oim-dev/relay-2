import { fileURLToPath } from "node:url";
import { runProcess } from "../../../src/transport/process";
import type { ExchangeProcessInput, ExchangeProcessObservation } from "./crash-exchange.types";

/**
 * Владеет отдельным Bun-процессом через production guardian с deadline и отменой fixture.
 * Проверяет именно аварийный exit 86, а не обработанный throw или штатный close SQLite.
 */
export async function runExchangeProcess(
  input: ExchangeProcessInput,
  signal: AbortSignal,
): Promise<ExchangeProcessObservation> {
  const result = await runProcess({
    executable: process.execPath,
    args: [fileURLToPath(new URL("./crash-exchange-actor.ts", import.meta.url))],
    cwd: input.directory,
    ...(input.repository.env ? { env: input.repository.env } : {}),
    input: JSON.stringify(input),
    signal,
    timeoutMs: 20_000,
  });
  const expectedCode = input.point === "complete" ? 0 : 86;
  if (result.exitCode !== expectedCode || result.stderr.length > 0) {
    throw new Error(
      `Процесс ${input.point}: exit=${result.exitCode}, ожидался ${expectedCode}\n${result.stderr.toString("utf8")}`,
    );
  }
  // Свидетельство пишет только типизированный fixture actor; это не вход production API.
  const observation = JSON.parse(result.stdout.toString("utf8")) as ExchangeProcessObservation;
  if (
    observation.point !== input.point ||
    observation.pid === process.pid ||
    !Number.isInteger(observation.pid) ||
    !/^[a-f0-9]{40,64}$/.test(observation.head)
  ) {
    throw new Error("Не получено свидетельство аварийной границы от отдельного процесса");
  }
  return observation;
}
