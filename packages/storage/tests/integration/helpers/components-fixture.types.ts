import type { Database } from "bun:sqlite";
import type { ProjectDatabase } from "../../../src/database/project-database";

/**
 * Изолированные соединения одной файловой SQLite; закрываются владельцем fixture.
 */
export interface ComponentsFixture {
  /* Проверяемый публичный адаптер хранения. */
  readonly db: ProjectDatabase;
  /* Raw SQL для проверки первичных строк и намеренного повреждения. */
  readonly raw: Database;
  /* Собственный каталог, разрешающий дополнительные независимые базы теста. */
  readonly directory: string;
}

/**
 * Узкая проекция SQLite bytecode для проверки чтения metadata без primary component payload.
 */
export interface ComponentReadInstruction {
  /* Имя SQLite opcode; проверяются открытия курсоров и чтения колонок. */
  readonly opcode: string;
  /* Первый операнд: номер курсора у OpenRead и Column. */
  readonly p1: number;
  /* Второй операнд: rootpage у OpenRead, номер колонки у Column. */
  readonly p2: number;
}
