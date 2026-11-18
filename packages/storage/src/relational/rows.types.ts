import type { EntityKind, ComponentKind, PortableEntityRecord } from "@relay/contracts";
import type { ENTITY_DEFINITIONS } from "./entity-definitions";
import type { COMPONENT_DEFINITIONS } from "./component-definitions";
import type { ColumnsRow } from "./columns.types";

/**
 * Переносимые метаданные предметной строки; локальная числовая CAS-ревизия сюда не входит.
 */
export interface EntityRowMetadata {
  /* Постоянный UUID предметной записи, одинаковый у всех реплик. */
  readonly id: string;
  /* Точное время создания из EntityRecord. */
  readonly created_at: string;
  /* Точное время последней правки содержания. */
  readonly updated_at: string;
  /* Неизменяемое авторство создания. */
  readonly created_by: string;
  /* Автор последней правки содержания. */
  readonly updated_by: string;
}

/**
 * Служебная форма строки части, общая для отдельных предметных таблиц.
 * parents_json содержит только канонический список хешей версий, не предметные отношения.
 */
export interface ComponentRowMetadata {
  /* ID предметного владельца; конкретный FK определяется таблицей. */
  readonly owner_id: string;
  /* Постоянный ID части внутри владельца и вида; не индекс массива. */
  readonly id: string;
  /* Устойчивый ключ пользовательского порядка. */
  readonly position: string;
  /* Переносимая content-версия — SHA-256 в нижнем hex-регистре. */
  readonly version: string;
  /* Точная JSON-строка упорядоченных хешей непосредственных предков. */
  readonly parents_json: string;
  /* 1 сохраняет снятое назначение вместе с его последним содержанием. */
  readonly deleted: 0 | 1;
}

/**
 * Типизированная альтернатива цели реализации; один из двух FK обязателен.
 */
export type ImplementationTargetColumns =
  | {
      /* Цель — вся функциональность. */
      readonly feature_id: string;
      /* Сценарий при цели-функциональности отсутствует. */
      readonly scenario_id: null;
    }
  | {
      /* Фича сценария получается через scenarios, повторный FK не хранится. */
      readonly feature_id: null;
      /* Цель — конкретный сценарий функциональности. */
      readonly scenario_id: string;
    };

/**
 * Ровно одна известная предметная цель задачи.
 */
export type TaskTargetColumns =
  | {
      /* Функциональность продуктовой доски. */
      readonly feature_id: string;
      /* Альтернативная цель отсутствует. */
      readonly scenario_id: null;
      /* Альтернативная цель отсутствует. */
      readonly implementation_id: null;
    }
  | {
      /* Альтернативная цель отсутствует. */
      readonly feature_id: null;
      /* Сценарий продуктовой доски. */
      readonly scenario_id: string;
      /* Альтернативная цель отсутствует. */
      readonly implementation_id: null;
    }
  | {
      /* Альтернативная цель отсутствует. */
      readonly feature_id: null;
      /* Альтернативная цель отсутствует. */
      readonly scenario_id: null;
      /* Реализация приложения-владельца доски. */
      readonly implementation_id: string;
    };

/**
 * Точные скаляры таблицы владельца, дополненные только физически необходимыми связями.
 */
export type EntityTableRow<K extends EntityKind> = EntityRowMetadata &
  ColumnsRow<(typeof ENTITY_DEFINITIONS)[K]["columns"]> &
  (K extends "implementation"
    ? ImplementationTargetColumns
    : K extends "document" | "product"
      ? {
          /* ID единственного проекта; у документа задаёт scope раздела. */
          readonly project_id: string;
        }
      : object);

/**
 * Точная строка таблицы части с дискриминированной предметной целью и ролью адреса.
 */
export type ComponentTableRow<K extends ComponentKind> = ComponentRowMetadata &
  ColumnsRow<(typeof COMPONENT_DEFINITIONS)[K]["columns"]> &
  (K extends "task-target"
    ? TaskTargetColumns
    : K extends "address-assignment"
      ? {
          /* Единственное действующее назначение текущего ключа владельца. */
          readonly is_current: 0 | 1;
        }
      : object);

/**
 * Минимальный реестр идентичности разнородных целей без содержания или метаданных.
 */
export interface ObjectIdentityRow {
  /* Постоянный UUID объекта в проекте. */
  readonly id: string;
  /* Неизменяемый вид предметной строки. */
  readonly kind: EntityKind;
}

/**
 * Снимок ссылки материала истории; подписи никогда не обновляются текущим JOIN.
 */
export interface CheckpointReferenceRow {
  /* ID неизменяемого материала истории. */
  readonly checkpoint_id: string;
  /* Постоянный ID цели в данном проекте. */
  readonly target_id: string;
  /* Сохранённый вид цели для FK реестра и истории. */
  readonly target_kind: EntityKind;
  /* Нулевая позиция снимка ссылки в исходном материале. */
  readonly position: number;
  /* Ключ цели именно на момент создания материала. */
  readonly snapshot_key: string;
  /* Точное название цели; null, если текст находится в carrier. */
  readonly snapshot_title: string | null;
  /* JSON-string carrier непарных UTF-16 units; null при обычном TEXT. */
  readonly snapshot_title_json: string | null;
}

/**
 * Факт приёмки прямого дочернего поручения отдельным неизменяемым материалом.
 */
export interface CheckpointAcceptanceRow {
  /* ID материала, сохранившего приёмку. */
  readonly checkpoint_id: string;
  /* ID принятой дочерней сессии, не её ключ. */
  readonly child_session_id: string;
  /* Нулевая позиция приёмки в исходном материале. */
  readonly position: number;
}

/**
 * Переносимая строка независимого журнала комментариев.
 * Локальный sequence SQLite не переносится; порядок задаётся after_id.
 */
export interface PortableCommentRow {
  /* Постоянный ID комментария. */
  readonly id: string;
  /* ID задачи-владельца журнала. */
  readonly task_id: string;
  /* Заголовок; null, если его точные code units находятся в title_json. */
  readonly title: string | null;
  /* Единственный JSON-string carrier заголовка; null при обычном TEXT. */
  readonly title_json: string | null;
  /* Основной текст; null, если его точные code units находятся в body_json. */
  readonly body: string | null;
  /* Единственный JSON-string carrier основного текста; null при обычном TEXT. */
  readonly body_json: string | null;
  /* Время создания комментария. */
  readonly created_at: string;
  /* Проверенный автор комментария. */
  readonly created_by: string;
  /* ID предыдущего комментария этой задачи; null у начала журнала. */
  readonly after_id: string | null;
}

/**
 * Переносимая content-версия владельца, отделённая от его local CAS.
 */
export interface PortableEntityVersionRow {
  /* Постоянный ID владельца версии. */
  readonly entity_id: string;
  /* Хеш точной совместимой raw-проекции. */
  readonly version: string;
  /* JSON-строка канонического массива предков; у исходной версии равна "[]". */
  readonly parents_json: string;
}

/**
 * Первоначальная неизменяемая квитанция пользовательской команды.
 */
export interface PortableReceiptRow {
  /* Ключ идемпотентности пользовательской операции. */
  readonly operation_key: string;
  /* Дословный исходный запрос; внутри могут быть JSON и исторические метаданные. */
  readonly request_json: string;
  /* Дословный первоначальный результат, включая исторические числовые ревизии. */
  readonly result_json: string;
}

/**
 * Переносимые подтверждения changeset одной реплики; значения являются техническим протоколом.
 */
export interface PortableConfirmationRow {
  /* Постоянный ID реплики — владельца подтверждённых последовательностей. */
  readonly replica_id: string;
  /* Точная JSON-строка канонического массива принятых интервалов. */
  readonly ranges_json: string;
  /* JSON-строка proofs; null сохраняет отсутствие optional proofs. */
  readonly proofs_json: string | null;
}

/**
 * Последняя проверенная публикация; её полный неизменяемый материал — технический JSON.
 */
export interface PortablePublicationRow {
  /* ID публикации, совпадающий с publicationId её payload. */
  readonly id: string;
  /* Полный точный материал ReplicationPublication в одном JSON-значении. */
  readonly payload_json: string;
}

/**
 * Закрытая карта переносимых первичных таблиц; тип каждой строки зависит от имени таблицы.
 */
export type PortableTableMap = {
  readonly [
    K in EntityKind as (typeof ENTITY_DEFINITIONS)[K]["table"]
  ]: readonly EntityTableRow<K>[];
} & {
  readonly [
    K in ComponentKind as (typeof COMPONENT_DEFINITIONS)[K]["table"]
  ]: readonly ComponentTableRow<K>[];
} & {
  /* Минимальный реестр разнородных целей. */
  readonly object_ids: readonly ObjectIdentityRow[];
  /* Исторические снимки ссылок. */
  readonly checkpoint_references: readonly CheckpointReferenceRow[];
  /* Исторические факты приёмки. */
  readonly checkpoint_acceptances: readonly CheckpointAcceptanceRow[];
  /* Независимый переносимый журнал задач. */
  readonly task_comments: readonly PortableCommentRow[];
  /* Версии содержания, никогда не локальные ревизии. */
  readonly replication_entity_versions: readonly PortableEntityVersionRow[];
  /* Первоначальные квитанции. */
  readonly batch_receipts: readonly PortableReceiptRow[];
  /* Подтверждения changeset по репликам. */
  readonly replication_confirmations: readonly PortableConfirmationRow[];
  /* Пусто при publication=null; иначе одна последняя публикация. */
  readonly replication_publications: readonly PortablePublicationRow[];
};

/**
 * Результат чистого разложения переносимого снимка на точные предметные строки.
 * Публикация и подтверждения также являются строками физических таблиц; local CAS отсутствует.
 */
export interface PortableTableRows {
  /* ID единственного проекта, проверяемый против строки projects. */
  readonly projectId: string;
  /* Закрытая карта таблиц: строка целиком помещается в один JSON-файл своей таблицы. */
  readonly tables: PortableTableMap;
}

/**
 * Контекст вывода связей, которые не дублируются в строке владельца.
 */
export interface EntityProjectionContext {
  /* ID единственного проекта; нужен для scoped разделов. */
  readonly projectId: string;
  /* Полные raw DTO по ID при кодировании; SQL-запись использует только собственный DTO. */
  readonly entities?: ReadonlyMap<string, PortableEntityRecord>;
}
