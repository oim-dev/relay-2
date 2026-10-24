import type { PortableProjectSnapshot } from "@relay/contracts";
import type { ProjectDatabase } from "@relay/storage";

/**
 * Изолированные реплики одной принятой исходной версии; соединения принадлежат fixture.
 */
export interface ReplicationFixture {
  /* Первая независимая SQLite с собственным replicaId. */
  readonly first: ProjectDatabase;
  /* Восстановленная вторая SQLite с другим replicaId. */
  readonly second: ProjectDatabase;
  /* Опубликованная исходная версия для обеих реплик. */
  readonly remote: PortableProjectSnapshot;
  /* Каталог для дополнительных независимых реплик теста. */
  readonly directory: string;
}

/**
 * Владение изолированной fixture для beforeEach/afterEach, без общей mutable БД между тестами.
 */
export interface OwnedReplicationFixture extends ReplicationFixture {
  /**
   * Идемпотентно закрывает соединения и удаляет только собственный каталог fixture.
   */
  close(): void;
}
