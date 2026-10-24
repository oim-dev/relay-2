import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNativeProcess, type ProcessResult } from "@relay/project-runtime";

/**
 * Запускает настоящие утилиты без shell и сохраняет диагностику каждого вызова в artifacts.
 * Этот наблюдатель не подставляется вместо runner или supervisorProbe проверяемого Runtime.
 */
export class NativeCommands {
  /* Последовательность журналов внутри одного fixture. */
  private sequence = 0;

  /**
   * Принимает существующий каталог журналов и явное окружение текущего пользователя.
   */
  constructor(
    /* Существующий корень журналов одного fixture. */
    readonly directory: string,
    /* Окружение native-команд без изменения process.env. */
    readonly env: Readonly<Record<string, string | undefined>>,
  ) {}

  /**
   * Выполняет ограниченную по времени команду; неизвестный exit code всегда проваливает проверку.
   */
  async run(executable: string, args: readonly string[], allowed = [0]): Promise<ProcessResult> {
    const path = join(this.directory, `command-${++this.sequence}.json`);
    try {
      const result = await runNativeProcess({
        executable,
        args,
        env: this.env,
        cwd: this.directory,
        timeoutMs: 30_000,
      });
      writeFileSync(path, JSON.stringify({ executable, args, ...result }, null, 2));
      if (!allowed.includes(result.exitCode)) {
        throw new Error(`Native command exit ${result.exitCode}: ${executable}; журнал ${path}`);
      }
      return result;
    } catch (error) {
      writeFileSync(`${path}.error.txt`, String(error));
      throw error;
    }
  }

  /**
   * Передаёт Unicode PowerShell как UTF-16, не вызывая профиль или интерактивный ввод.
   */
  async powershell(source: string): Promise<unknown> {
    const preamble =
      "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ";
    const result = await this.run("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(preamble + source, "utf16le").toString("base64"),
    ]);
    return JSON.parse(result.stdout.replace(/^\uFEFF/u, ""));
  }
}

/**
 * Кодирует одну строковую константу внутри PowerShell EncodedCommand.
 */
export function psString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Сохраняет вложенные причины и ошибки finally, которые обычный JSON.stringify(Error) теряет.
 */
export function failureDiagnostic(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return String(error);
  }
  return {
    message: error.message,
    stack: error.stack,
    ...("code" in error ? { code: error.code } : {}),
    ...("details" in error ? { details: error.details } : {}),
    ...(error.cause === undefined ? {} : { cause: failureDiagnostic(error.cause) }),
    ...(error instanceof AggregateError ? { errors: error.errors.map(failureDiagnostic) } : {}),
  };
}
