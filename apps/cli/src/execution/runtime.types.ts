import type { GitSyncClient } from "@relay/project-runtime";

/**
 * Окружение одного вызова CLI, передаваемое явно для изоляции параллельных запусков.
 * Чтение stdin откладывается до выбора файлового источника «-».
 */
export interface CliRuntime {
  /* Рабочий каталог для разрешения относительных путей; глобальный cwd не меняется. */
  readonly cwd: string;
  /* Снимок или переданное окружение; отсутствующая переменная имеет значение undefined. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /* Готовый текст либо ленивый читатель; maxBytes ограничивает поток до накопления полного ввода. */
  readonly stdin: string | ((maxBytes?: number) => string | Promise<string>);
  /* Процессный порт Git Sync; отсутствие использует ленивый production client Runtime. */
  readonly gitSync?: GitSyncClient;
  /* Путь исполняемой CLI для sibling discovery; процессный вход передаёт process.execPath. */
  readonly executablePath?: string;
  /* Сигнал отмены только текущего вызова; глобальные listeners подключает процессный вход. */
  readonly signal?: AbortSignal;
  /* Процессный вход подключает сигналы только после ввода process-action и снимает их после сценария. */
  readonly withProcessSignals?: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  /* Потоковый вывод foreground supervisor, подключённый runCli/runProcessCli. */
  readonly stdout?: (text: string) => void;
  /* Потоковая диагностика foreground supervisor. */
  readonly stderr?: (text: string) => void;
}
