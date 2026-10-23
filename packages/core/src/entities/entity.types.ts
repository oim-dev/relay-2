import type { EntityKind, EntityRecord, WriteOptions } from "@relay/contracts";

/**
 * Подготовленное изменение содержания либо ключа; отсутствие полей patch означает no-op.
 */
export type EntityChange =
  | {
      /* Частичный проверенный JSON; остальные поля актуальной записи сохраняются. */
      readonly patch: Readonly<Record<string, unknown>>;
    }
  | {
      /* Новый ключ; прежний остаётся алиасом после успешного CAS. */
      readonly key: string;
    };

/**
 * Подготовка изменения по независимой копии актуальной записи внутри транзакции.
 * Полученный объект не является доверенным снимком для последующих вызовов записи.
 */
export type PrepareEntityChange = (current: Readonly<EntityRecord>) => EntityChange;

/**
 * Внутренний выбор CAS: входная ревизия либо ревизия адресно прочитанного связанного владельца.
 */
export type EntityMutationOptions =
  | {
      /* Ревизия передана вызывающим сценарием и никогда не подменяется. */
      readonly kind: "explicit";
      /* Автор и обязательная ожидаемая ревизия. */
      readonly write: Readonly<WriteOptions>;
    }
  | {
      /* Внутренний шаг связанного агрегата под внешней транзакцией. */
      readonly kind: "related";
      /* Автор основной предметной операции. */
      readonly actor: string;
    };

/**
 * Назначение строкового адреса при проверке ссылок и назначении ключа.
 */
export type EntityAddressField = "ref" | "prefix" | "key";

/**
 * Разобранная пользовательская ссылка до обращения к хранилищу.
 */
export interface EntityReference {
  /* ID, ключ, алиас или виртуальный адрес без префикса вида. */
  readonly ref: string;
  /* Ожидаемый вид записи; undefined разрешает прямой адрес любого вида. */
  readonly kind: EntityKind | undefined;
}

/**
 * Проверенное JSON-значение без циклов и пропусков массивов, только с конечными числами.
 */
export type EntityJsonValue =
  null | string | boolean | number | readonly EntityJsonValue[] | EntityJsonObject;

/**
 * Проверенный JSON-объект для внутренней записи предметного содержания.
 * Допускается обычный объект или объект без прототипа; вход не изменяется.
 */
export interface EntityJsonObject {
  /* Собственные перечислимые поля содержания, проверенные перед сохранением. */
  readonly [field: string]: EntityJsonValue;
}
