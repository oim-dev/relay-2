import type { BatchOptions, BatchReference, BatchRevisionReference } from "./batch.types";
import type { ExpectedEntityAddress } from "../replication/replication.types";

/**
 * Одна именованная предметная команда из BATCH_OPERATIONS.
 * Вход проверяется каталогом и владельцем операции, не применяется как произвольная JSON-мутация.
 */
export interface NamedCommand {
  /* Точное имя опубликованной операции, например document.update. */
  readonly op: string;
  /* Необязательное локальное имя результата для последующих команд одного атомарного массива. */
  readonly as?: string;
  /* Адрес основного владельца; отсутствует у создания и singleton-операций. */
  readonly ref?: string | BatchReference;
  /* Ожидаемая локальная CAS-ревизия владельца; требуется правилами операции. */
  readonly ifRevision?: number | BatchRevisionReference;
  /* Переносимый aggregateVersion владельца из versioned read; проверяется также при no-op. */
  readonly expectedVersion?: string;
  /* Именованные параметры выбранного действия; форму проверяет предметный сервис. */
  readonly input?: Readonly<Record<string, unknown>>;
}

/**
 * Параметры единого исполнителя. Одиночная команда не требует пользовательской квитанции.
 * После чтения предварительного ключа передавайте expectedAddresses либо постоянный ID в ref.
 */
export interface CommandOptions extends BatchOptions {
  /* Привязки прочитанных адресов к ID, проверяемые атомарно до исполнения команды/пакета. */
  readonly expectedAddresses?: readonly ExpectedEntityAddress[];
}

/**
 * Дополнительный контекст точечного фасада, общий для всех его предметных записей.
 * Не содержит свежего CAS и не меняет пользовательские версии.
 */
export interface CommandExecutionContext {
  /* Привязки адресов, с которыми работал вызывающий; отсутствие не отменяет защиту remapped keys. */
  readonly expectedAddresses?: readonly ExpectedEntityAddress[];
  /* Переносимое условие владельца по умолчанию; явно переданный token метода имеет приоритет. */
  readonly expectedVersion?: string;
}
