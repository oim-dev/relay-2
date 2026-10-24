import type { Args, Command } from "gunshi";
import type { Result, TextPresentation } from "../output/output.types";
import type { CommandHelp } from "../output/help.types";
import type { ArgumentValues, InputFields } from "../input/arguments.types";
import type { CliRuntime } from "./runtime.types";
import type { CliFailure } from "../errors/errors.types";
import type { VersionFlagPair } from "../input/version-precondition.types";

/**
 * Общая CLI-схема действия; предметный способ исполнения определяется отдельным вариантом Action.
 */
export interface ActionDefinition extends CommandHelp {
  /* Позиционные и управляющие параметры, не входящие в объект предметных полей. */
  readonly args?: Args;
  /* Источники предметных полей; их чтение заканчивается до открытия БД. */
  readonly fields?: Args;
  /* Специальный источник ввода; читается до создания Invocation и открытия проектной БД. */
  readonly readInput?: (values: ArgumentValues, runtime: CliRuntime) => Promise<InputFields>;
  /* Явный макет только текстового ответа; отсутствие сохраняет общее представление. */
  readonly presentation?: TextPresentation;
}

/**
 * Строго синхронное чтение в снимке либо локальный сценарий, самостоятельно владеющий ресурсами.
 */
export interface SynchronousAction<TInvocation> extends ActionDefinition {
  /* Отсутствие режима отличает синхронное чтение/локальную операцию от предметного writer. */
  readonly mode?: never;
  /* Локальный сценарий не требует проектной БД и самостоятельно владеет своими ресурсами. */
  readonly local?: boolean;
  /* service передаёт владение снимком читателю Core; соединение всё равно закрывает CLI. */
  readonly execution?: "service";
  /* Promise не допускается в синхронный callback снимка SQLite. */
  readonly run: (invocation: TInvocation) => Result;
}

/**
 * Предметная мутация через async Core executor; внешней SQLite-транзакции у CLI нет.
 */
export interface MutationAction<TInvocation> extends ActionDefinition {
  /* create проверяет автора; update требует хотя бы одно исходное предусловие владельца. */
  readonly mode: "create" | "update";
  /* Предметные writers используют проектное соединение и не являются локальными FS-сценариями. */
  readonly local?: never;
  /* Явная совместимая метка владения транзакцией Core, например для batch. */
  readonly execution?: "service";
  /* Дополнительные пары предусловий, например самостоятельный target у transfer. */
  readonly versionPairs?: readonly VersionFlagPair[];
  /* Завершённый результат после commit либо отвергнутый Promise; без повторения записи реестром. */
  readonly run: (invocation: TInvocation) => Promise<Result>;
}

/**
 * Асинхронное составное чтение с собственной согласованностью Core и рабочим Invocation.
 * Его Promise никогда не исполняется внутри синхронного SQLite snapshot CLI.
 */
export interface ServiceReadAction<TInvocation> extends ActionDefinition {
  /* Чтение не требует автора и не создаёт execution context записи. */
  readonly mode?: never;
  /* Ресурсом проектного соединения до settlement владеет Invocation. */
  readonly local?: never;
  /* Явная async-граница versioned/projected reader владельца Core. */
  readonly execution: "service-read";
  /* Полный результат чтения и metadata того же anchor; ошибка отклоняет Promise. */
  readonly run: (invocation: TInvocation) => Promise<Result>;
}

/**
 * Разделяет синхронный snapshot, асинхронную запись и асинхронное составное чтение Core.
 */
export type Action<TInvocation> =
  SynchronousAction<TInvocation> | MutationAction<TInvocation> | ServiceReadAction<TInvocation>;

/**
 * Честная асинхронная граница процесса/локального сценария; не может попасть в SQLite callback.
 */
export interface ProcessAction<TInvocation> extends CommandHelp {
  /* Параметры CLI, включая единственный источник JSON при необходимости. */
  readonly args?: Args;
  /* Асинхронное чтение до запуска процесса; справка не вызывает читатель. */
  readonly readInput?: (values: ArgumentValues, runtime: CliRuntime) => Promise<InputFields>;
  /* Макет текстового результата; JSON сохраняет исходную форму. */
  readonly presentation?: TextPresentation;
  /* Сценарий без проектной БД и внешней транзакционной обёртки. */
  readonly run: (invocation: TInvocation) => Promise<Result>;
}

/**
 * Исход одного запуска, отделённый от строки Gunshi и JSON-данных предметного результата.
 */
export interface CommandOutcome {
  /* Первая ошибка частичного результата; отсутствие означает успешное завершение. */
  failure?: CliFailure;
}

/**
 * Узел дерева регистрации; все дочерние узлы создаются реестром как изменяемая Map.
 * Явная форма исключает приведение произвольных subCommands стороннего API.
 */
export interface RegistryCommand extends Command {
  /* Техническое имя одного сегмента команды, без родительского пути. */
  name: string;
  /* Дочерние команды в порядке регистрации для воспроизводимой справки. */
  subCommands: Map<string, RegistryCommand>;
}
