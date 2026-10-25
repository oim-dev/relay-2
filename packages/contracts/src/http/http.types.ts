import type { NamedCommand } from "../batch/command.types";
import type { ExpectedEntityAddress } from "../replication/replication.types";
import type { EntityKind } from "../entities/identity.types";
import type { EntityPage, EntityPageRequest } from "../pagination/pagination.types";
import type { ProjectEntity } from "../project-entity.types";
import type { KnowledgeRecord } from "../knowledge/knowledge.types";
import type { VersionedEntityReadResult } from "../commands/command-store.types";

/**
 * Машинная диагностика HTTP без стека и процессного exit code.
 */
export interface HttpError {
  /* Стабильный код Core, Runtime либо HTTP-границы. */
  readonly code: string;
  /* Сообщение для человека. */
  readonly message: string;
  /* Дополнительные сведения; отсутствие не равно пустому объекту. */
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Metadata чтения; версии принадлежат тому же anchor, что возвращённые карточки.
 */
export interface HttpMeta {
  /* Переносимые record/aggregate tokens успешных постоянных ID. */
  readonly versions?: VersionedEntityReadResult["versions"];
  /* Поколение согласованного чтения, если оно возвращается отдельно от данных. */
  readonly generation?: number;
}

/**
 * Успешная оболочка JSON для HTTP 200; не содержит ветви предметного или транспортного отказа.
 */
export interface HttpSuccessResponse<T> {
  /* Успешный discriminator связывает data с точным DTO операции. */
  readonly ok: true;
  /* Результат сценария без транспортного изменения предметных полей. */
  readonly data: T;
  /* Отдельные версии/поколение исходного чтения, когда запрошены. */
  readonly meta?: HttpMeta;
}

/**
 * Общая оболочка результата; сохраняет обе ветви для клиентов и внутренних validators.
 */
export type HttpResponse<T> =
  | HttpSuccessResponse<T>
  | {
      /* Дискриминатор отказа; data у ошибочного ответа отсутствует. */
      readonly ok: false;
      /* Исходная предметная либо транспортная диагностика. */
      readonly error: HttpError;
    };

/**
 * Регистрация проекта, включая недоступную; name сохраняет имя workspace-регистрации.
 */
export interface ServerProject {
  /* ID проверенной БД либо null, когда регистрация недоступна. */
  readonly id: string | null;
  /* Имя регистрации workspace либо название локального проекта. */
  readonly name: string;
  /* Канонический slug проекта либо null при недоступности. */
  readonly slug: string | null;
  /* Проверена возможность открыть именно эту физическую БД. */
  readonly available: boolean;
  /* Причина недоступности, если есть. */
  readonly error?: HttpError;
}

/**
 * Контекст одного сервера; actor служит явным начальным значением формы записи.
 */
export interface ServerContext {
  /* Версия поставки сервера, независимо от версии HTTP API. */
  readonly version: string;
  /* Локальный проект либо реестр независимых проектов. */
  readonly mode: "project" | "workspace";
  /* Регистрации в исходном порядке; недоступные не исключаются. */
  readonly projects: readonly ServerProject[];
  /* Автор по умолчанию; мутации всё равно обязаны передавать actor. */
  readonly actor: string;
}

/**
 * HTTP-контекст записи. Ключ обязателен даже для одиночной команды.
 */
export interface HttpWriteContext {
  /* Явное неизменённое авторство пользователя. */
  readonly actor: string;
  /* Уникальный ключ первоначального запроса; повтор с иным содержанием — конфликт. */
  readonly operationKey: string;
  /* Исходные привязки адресов; сервер не подставляет текущие ID. */
  readonly expectedAddresses?: readonly ExpectedEntityAddress[];
}

/**
 * Одиночная текущая NamedCommand с отдельными транспортными условиями.
 */
export type HttpCommandRequest = NamedCommand & HttpWriteContext;

/**
 * Атомарный набор текущих команд; check проходит тот же путь с откатом.
 */
export interface HttpBatchRequest extends HttpWriteContext {
  /* Последовательность команд с локальными ссылками на предыдущие результаты. */
  readonly commands: readonly NamedCommand[];
  /* true проверяет пакет без сохранения receipt и изменений. */
  readonly check?: boolean;
}

/**
 * Страница, привязанная к поколению одного SQLite snapshot.
 */
export interface HttpPage<T> extends EntityPage<T> {
  /* Поколение, проверенное в том же snapshot, что items/total. */
  readonly generation: number;
  /* Следующий offset либо null после последней страницы. */
  readonly nextOffset: number | null;
}

/**
 * Список вида с фильтрами Core; offset > 0 требует исходного generation.
 */
export interface HttpEntityQuery extends Partial<EntityPageRequest> {
  /* Вид обязателен: не запускает скрытый полный обзор всех видов. */
  readonly kind: EntityKind;
  /* Поколение предыдущей страницы, обязательное для продолжения. */
  readonly generation?: number;
  /* Поиск по правилам владельца вида. */
  readonly q?: string;
  /* Предметный статус планирования, истории или знаний. */
  readonly status?: string;
  /* Прочие фильтры передаются владельцу и проверяются им без подмены. */
  readonly [filter: string]: string | number | boolean | undefined;
}

/**
 * Проекция текущего Core overview без полного повторного массива карточек.
 */
export interface HttpOverview {
  /* Проверенная карточка проекта. */
  readonly project: KnowledgeRecord<"project">;
  /* Поколение общего снимка обзора. */
  readonly generation: number;
  /* Количество записей каждого текущего вида. */
  readonly counts: Readonly<Record<EntityKind, number>>;
  /* Текущие Core-агрегаты задач, без старых Web-метрик. */
  readonly tasks: {
    /* Число всех задач. */
    readonly total: number;
    /* Число задач по штатным колонкам. */
    readonly columns: Readonly<Record<string, number>>;
    /* Задачи с незавершёнными прямыми обязательствами. */
    readonly blocked: number;
  };
}

/**
 * SSE уведомляет об инвалидировании кеша, не переносит полный snapshot проекта.
 */
export type HttpProjectEvent =
  | {
      /* Подключение/reconnect, изменение поколения либо подтверждение живого stream. */
      readonly type: "connected" | "changed" | "heartbeat";
      /* Постоянный ID обслуживаемого проекта. */
      readonly projectId: string;
      /* Последнее успешно прочитанное поколение SQLite. */
      readonly generation: number;
    }
  | {
      /* Отказ чтения не подменяется heartbeat или пустым проектом. */
      readonly type: "storage-error";
      /* Постоянный ID недоступного проекта. */
      readonly projectId: string;
      /* Последнее известное поколение; null, если ещё неизвестно. */
      readonly generation: number | null;
      /* Диагностика текущего отказа Storage/Runtime. */
      readonly error: HttpError;
    };

/**
 * Полное адресное чтение; ProjectEntity сохраняет связь kind и data.
 */
export type HttpEntityPage = HttpPage<ProjectEntity>;

/**
 * Текущий технический status Core; размер основного SQLite файла не включает WAL/SHM.
 */
export interface HttpProjectStatus {
  /* Постоянный ID выбранной БД. */
  readonly projectId: string;
  /* Локальный путь основного файла выбранного проекта. */
  readonly databasePath: string;
  /* Размер основного файла в байтах, полученный отдельно от SQL snapshot. */
  readonly bytes: number;
  /* Поколение общего snapshot счётчика records. */
  readonly generation: number;
  /* Число всех текущих сущностей без чтения их содержания. */
  readonly records: number;
}

/**
 * Успешная диагностика целостности Core; нарушение возвращается HTTP-ошибкой INTEGRITY_ERROR.
 */
export interface HttpProjectCheck {
  /* Постоянный ID проверенного проекта. */
  readonly projectId: string;
  /* Поколение проверенного snapshot. */
  readonly generation: number;
  /* Фактический результат текущей проверки Core. */
  readonly valid: boolean;
  /* Число проверенных предметных записей. */
  readonly records: number;
  /* Диагностики Core; при успешном результате массив пуст. */
  readonly issues: readonly string[];
}
