import { fileURLToPath } from "node:url";
import { runProcess } from "../../../src/transport/process";
import type { ExchangeProcessInput, ExchangeProcessObservation } from "./crash-exchange.types";

/**
 * Владеет отдельным Bun-процессом через production guardian с deadline и отменой fixture.
 * Возвращается только после ожидаемого exit 86/0 и drain guardian, до повторного открытия БД.
 * Авария — настоящий process.exit, не обработанный throw или штатный close SQLite.
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
    typeof observation.instance !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      observation.instance,
    ) ||
    observation.pid === process.pid ||
    !Number.isInteger(observation.pid) ||
    observation.pid <= 0 ||
    !/^[a-f0-9]{40,64}$/.test(observation.head)
  ) {
    throw new Error("Не получено свидетельство аварийной границы от отдельного процесса");
  }
  return observation;
}
