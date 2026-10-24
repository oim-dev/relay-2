import type { PortableProjectSnapshot, ReplicationChangeset } from "@relay/contracts";
import type { ProjectDatabase } from "@relay/core";
import type { SyncEngine } from "../../../src/sync/engine";
import type { ReplicationAdapter } from "../../../src/sync/replication-adapter";
import type { TeamRepository } from "./publication-barrier";
import type {
  ExchangeProcessAttempt,
  ExchangeProcessObservation,
} from "../helpers/crash-exchange.types";

/**
 * Конечный бюджет сценария; отмена не отделяет ожидание ресурсов от lifetime fixture.
 */
export interface TeamFixtureOptions {
  /* Общий deadline в миллисекундах; по умолчанию 240000 для extended-команды из 50 реплик. */
  readonly deadlineMs?: number;
}

/**
 * Один независимый участник: своё файловое хранилище, Git и локальное окружение.
 * После reopen/restore и отдельного process fixture заменяет соединение и связанные с ним сервисы.
 */
export interface TeamReplica {
  /* Номер участника в конечном сценарии, не replicaId протокола. */
  readonly index: number;
  /* Приватные файлы транспорта и диагностики этой реплики. */
  readonly directory: string;
  /* Отдельный пользовательский HOME, не каталог пользователя хоста. */
  readonly home: string;
  /* Отдельный RELAY_HOME с SQLite одного projectId. */
  readonly relayHome: string;
  /* Открытая файловая SQLite; закрытием владеет fixture. */
  db: ProjectDatabase;
  /* Реальный адаптер предметной репликации над текущим соединением. */
  replication: ReplicationAdapter;
  /* Реальный транспорт; после отдельного process заменяется для сброса cached refs. */
  repository: TeamRepository;
  /* Сценарий приложения, пересоздаваемый при замене соединения. */
  engine: SyncEngine;
}

/**
 * Владелец ресурсов конечного командного сценария; все каталоги удаляются в finally.
 */
export interface TeamFixture {
  /* Единственный локальный bare origin, созданный специально для проверки. */
  readonly origin: string;
  /* Единственная общая ветка данных origin. */
  readonly branch: string;
  /* Созданные участники в порядке index; новых участников добавляет replica(). */
  readonly replicas: TeamReplica[];
  /* Общая отмена с конечным deadline; передаётся Git и барьерам. */
  readonly signal: AbortSignal;
  /* Создаёт БД и Git-копию; snapshot восстанавливается реальным bootstrap API Core. */
  replica(snapshot?: PortableProjectSnapshot): Promise<TeamReplica>;
  /* Закрывает и открывает тот же файл, сохраняя replicaId и durable outbox. */
  reopen(replica: TeamReplica): void;
  /* Передаёт БД новому процессу; после его выхода пересоздаёт соединение, engine и Git caches. */
  exchangeInProcess(
    replica: TeamReplica,
    attempt: ExchangeProcessAttempt,
  ): Promise<ExchangeProcessObservation>;
  /* Восстанавливает новую БД из опубликованного snapshot, с новым replicaId. */
  restore(replica: TeamReplica, snapshot: PortableProjectSnapshot): void;
  /* Выполняет адресную Git-проверку origin с изолированным окружением и deadline. */
  originGit(args: readonly string[]): Promise<string>;
}

/**
 * Фактическая попытка push для доказательства настоящего non-fast-forward и retry.
 */
export interface PublicationAttempt {
  /* SHA опубликованного либо отвергнутого кандидата. */
  readonly commit: string;
  /* HEAD, относительно которого приложение подготовило этот кандидат. */
  readonly parent: string | null;
  /* Реальный exit code Git до возможной потери ответа тестовым адаптером. */
  readonly exitCode: number;
  /* Машинный porcelain-ответ настоящего Git. */
  readonly stdout: string;
}

/**
 * Сохранённая идентичность ожидаемой доставки; payload не пересчитывается в тесте.
 */
export type ExpectedChangeset = Pick<
  ReplicationChangeset,
  "id" | "replicaId" | "sequence" | "digest"
>;
