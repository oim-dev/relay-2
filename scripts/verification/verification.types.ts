/**
 * Декларация одной workspace-команды без рекурсивного запуска соседних проверок.
 */
export interface Component {
  /* Имя каталога компонента для CI и диагностики. */
  readonly id: string;
  /* Имя workspace в package.json. */
  readonly name: string;
  /* Каталог от корня checkout. */
  readonly directory: string;
  /* Объявленные package scripts; команды исполняются дословно Bun. */
  readonly scripts: Readonly<Record<string, string>>;
}

/**
 * Самостоятельный результат сборки для передачи между CI jobs.
 */
export interface BuildArtifact {
  /* Уникальное имя производителя. */
  readonly id: string;
  /* Компонент, единственный build которого создаёт результат. */
  readonly component: string;
  /* Каталог результата относительно checkout, без родительских переходов. */
  readonly directory: string;
  /* Переносимый результат JS/assets либо executable конкретной ОС/архитектуры. */
  readonly portable: boolean;
}

/**
 * Поддержанный CI target с закреплённым образом runner.
 */
export interface CiTarget {
  /* Публичное имя ОС и архитектуры в job и артефакте. */
  readonly id: string;
  /* Метка GitHub runner; версия образа задана явно. */
  readonly runner: string;
  /* Платформа Bun/Node. */
  readonly platform: "linux" | "darwin" | "win32";
  /* Архитектура поставляемого бинарника. */
  readonly arch: "x64" | "arm64";
}

/**
 * Описанный job GitHub Actions; leaf-команды принадлежат package scripts.
 */
export interface CiJob {
  /* Видимое имя компонента, операции и target. */
  readonly name: string;
  /* Идентификаторы необходимых производителей артефактов. */
  readonly needs?: readonly string[];
  /* Переиспользуемый workflow либо локальные steps. */
  readonly uses?: string;
  /* Проверенные параметры переиспользуемого workflow. */
  readonly with?: Readonly<Record<string, string>>;
  /* Runner самостоятельного итогового job. */
  readonly "runs-on"?: string;
  /* Условие итогового job, выполняемого также после отказа зависимостей. */
  readonly if?: string;
  /* Объявленные шаги итогового job. */
  readonly steps?: readonly Readonly<Record<string, unknown>>[];
}
