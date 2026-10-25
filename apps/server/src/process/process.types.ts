import type { RuntimeOptions, ServerStartInput } from "@relay/project-runtime";

/**
 * Снимок окружения на внешней процессной границе; внутренние сценарии env не читают.
 */
export interface ServerEnvironment {
  /* Рабочий каталог запуска. */
  readonly cwd: string;
  /* Снимок environment для Runtime и явных флагов приложения. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /* Bun либо самостоятельный relay-server binary. */
  readonly executablePath: string;
  /* Домашний каталог пользователя для выбора default Relay home. */
  readonly userHome: string;
  /* Standalone binary исполняет собственную guardian-роль. */
  readonly standalone: boolean;
}

/**
 * Проверенный запрос процесса; help/version не разрешают project config.
 */
export type ServerInvocation =
  | {
      /* Автономное действие, не открывающее конфигурацию проекта. */
      readonly kind: "help" | "version";
    }
  | {
      /* Прямой foreground запуск с новой Runtime регистрацией. */
      readonly kind: "direct";
      /* Явная область проекта/workspace. */
      readonly runtime: RuntimeOptions;
      /* Автор и порт будущего launch. */
      readonly input: ServerStartInput;
      /* Дополнительные origins dev frontend. */
      readonly allowedOrigins: readonly string[];
    }
  | {
      /* Сохранённый launch без переопределения его предметной области. */
      readonly kind: "launch";
      /* Абсолютный путь Runtime launch. */
      readonly path: string;
      /* EOF stdin запрашивает остановку только foreground запуска. */
      readonly parentLease: boolean;
      /* Явно разрешённые dev origins из текущей среды/флагов. */
      readonly allowedOrigins: readonly string[];
    };

/**
 * Граница lifecycle без прямых process listeners внутри bootstrap.
 */
export interface ServerControl {
  /* Единственный сигнал shutdown от ОС, stdin lease или Runtime control. */
  readonly signal: AbortSignal;
  /* Идемпотентно запрашивает graceful shutdown. */
  readonly stop: () => void;
  /* Ожидает flush ready-сообщения либо сообщает отказ. */
  readonly stdout: (text: string) => Promise<void>;
}
