import type { Args, Command } from "gunshi";
import type { Result } from "../output/output.types";

/**
 * Описание действия, связывающее синтаксис команды с синхронным предметным обработчиком.
 * Тип вызова передаёт реестр: контракт не зависит от реализации Invocation или сервисов Core.
 */
export interface Action<TInvocation> {
  /* Полное описание действия для русской справки. */
  readonly description: string;
  /* Позиционные и управляющие параметры, не входящие в объект предметных полей. */
  readonly args?: Args;
  /* Источники предметных полей; их чтение заканчивается до открытия БД. */
  readonly fields?: Args;
  /* create проверяет автора, update дополнительно требует if-revision; оба используют транзакцию. */
  readonly mode?: "create" | "update";
  /* Локальное действие самостоятельно выбирает ресурсы и не получает обёртку транзакции БД. */
  readonly local?: boolean;
  /* Синхронный сценарий; его предметные проверки и запись удерживаются в общей транзакции. */
  readonly run: (invocation: TInvocation) => Result;
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
