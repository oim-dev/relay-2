import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sourceGuardianComponent } from "./component";
import { GuardedCommandError } from "./errors";
import { combineProcessFailures } from "./component-failures";

/**
 * Собирает новый bytecode executable только из собственного source entry Runtime текущим Bun.
 * Каталог создаётся эксклюзивно: существующие файлы не заменяются. Готовый каталог принадлежит
 * вызывающему, который обязан дождаться всех guarded commands до его удаления.
 * Старые dist, environment overrides и проверяемый target не используются как guardian.
 * При отказе cleanup сохраняет ошибку сборки и удаления вместе, включая типизированную primary.
 */
export async function buildSourceGuardianComponent(directory: string): Promise<readonly string[]> {
  const source = sourceGuardianComponent();
  const entry = source?.[1];
  if (entry === undefined) {
    throw new GuardedCommandError("guardian");
  }
  mkdirSync(directory, { mode: 0o700 });
  try {
    const outfile = join(directory, process.platform === "win32" ? "guardian.exe" : "guardian");
    const result = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      format: "esm",
      bytecode: true,
      compile: {
        outfile,
        autoloadDotenv: false,
        autoloadBunfig: false,
        autoloadPackageJson: false,
        autoloadTsconfig: false,
      },
    });
    if (!result.success) {
      throw new GuardedCommandError("guardian", { cause: new AggregateError(result.logs) });
    }
    return Object.freeze([outfile]);
  } catch (error) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw combineProcessFailures(error, cleanupError);
    }
    throw error;
  }
}
