import type { Args, Command } from "gunshi";
import type { Result, TextPresentation } from "../output/output.types";
import type { CommandHelp } from "../output/help.types";
import type { ArgumentValues, InputFields } from "../input/arguments.types";
import type { CliRuntime } from "./runtime.types";
import type { CliFailure } from "../errors/errors.types";

/**
 * Описание действия, связывающее синтаксис команды с синхронным предметным обработчиком.
 * Тип вызова передаёт реестр: контракт не зависит от реализации Invocation или сервисов Core.
 */
export interface Action<TInvocation> extends CommandHelp {
  /* Позиционные и управляющие параметры, не входящие в объект предметных полей. */
  readonly args?: Args;
  /* Источники предметных полей; их чтение заканчивается до открытия БД. */
  readonly fields?: Args;
  /* Специальный источник ввода; читается до создания Invocation и открытия проектной БД. */
  readonly readInput?: (values: ArgumentValues, runtime: CliRuntime) => Promise<InputFields>;
  /* create проверяет автора, update требует if-revision; без execution сервис обёрнут транзакцией. */
  readonly mode?: "create" | "update";
  /* Локальное действие самостоятельно выбирает ресурсы и не получает обёртку транзакции БД. */
  readonly local?: boolean;
  /* service передаёт владение транзакцией/rollback сервису; соединение всё равно закрывает CLI. */
  readonly execution?: "service";
  /* Явный макет только текстового ответа; отсутствие сохраняет общее представление. */
  readonly presentation?: TextPresentation;
  /* Синхронный сценарий; граница транзакции/снимка определяется execution, mode и local. */
  readonly run: (invocation: TInvocation) => Result;
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
