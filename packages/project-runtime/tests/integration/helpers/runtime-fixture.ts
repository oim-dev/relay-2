import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { RelayError } from "@relay/contracts";
import { ProjectDatabase } from "@relay/storage";
import type { ProjectLocation } from "@relay/project-runtime";
import type { RuntimeChild } from "./runtime-fixture.types";

/**
 * Владеет изолированными каталогами и дочерними процессами одного интеграционного теста.
 * Создаёт только пустой cwd; проекты и workspace тест готовит явно.
 */
export class RuntimeFixture {
  /* Уникальный корень теста внутри датированного каталога артефактов. */
  readonly root: string;
  /* Существующий пустой рабочий каталог вызовов Runtime. */
  readonly cwd: string;
  /* Изолированный корень будущих баз; до первого init не существует. */
  readonly home: string;
  /* Дочерние процессы fixture; завершаются до удаления каталогов. */
  private readonly children: RuntimeChild[] = [];

  /**
   * Создаёт изолированный рабочий каталог без изменения cwd и окружения процесса тестов.
   * artifactGroup выбирает подкаталог внутри дневных артефактов для согласованного набора проверок.
   */
  constructor(artifactGroup = "style-refactor") {
    const artifacts = resolve(
      import.meta.dir,
      "../../../../../.artifacts",
      new Date().toISOString().slice(0, 10),
      artifactGroup,
    );
    mkdirSync(artifacts, { recursive: true });
    this.root = mkdtempSync(join(artifacts, "runtime-test-"));
    this.cwd = join(this.root, "work");
    this.home = join(this.root, "home");
    mkdirSync(this.cwd);
  }

  /**
   * Передаёт fixture владение процессом для обязательной очистки после успеха или отказа.
   */
  trackChild(child: RuntimeChild): void {
    this.children.push(child);
  }

  /**
   * Останавливает всех детей, дожидается завершения и удаляет файлы теста.
   */
  async dispose(): Promise<void> {
    try {
      for (const child of this.children) {
        child.kill();
      }
      await Promise.allSettled(this.children.splice(0).map((child) => child.exited));
    } finally {
      rmSync(this.root, { recursive: true, force: true });
    }
  }
}

/**
 * Выполняет отказавшее действие, проверяет тип RelayError и возвращает предметный код.
 * Успех и посторонние исключения не могут пройти отрицательное утверждение теста.
 */
export function runtimeErrorCode(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(RelayError);
    if (!(error instanceof RelayError)) {
      throw error;
    }
    return error.code;
  }
  throw new Error("Ожидался отказ операции");
}

/**
 * Записывает тестовый JSON, включая намеренно повреждённую схему, с созданием родителей.
 * Владение файлами и их очистка остаются у fixture вызывающего теста.
 */
export function writeConfig(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

/**
 * Открывает реальную базу для синхронной подготовки или проверки и закрывает её даже при отказе.
 */
export function withProjectDatabase<T>(
  project: ProjectLocation,
  operation: (database: ProjectDatabase) => T,
): T {
  const database = ProjectDatabase.open(project.databasePath);
  try {
    return operation(database);
  } finally {
    database.close();
  }
}
