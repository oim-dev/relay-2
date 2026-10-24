import { expect, test } from "bun:test";
import {
  RelayError,
  type CommandStore,
  type CommandSelector,
  type CommandLoadRequest,
  type CommandLoadResult,
  type CommandCommitPlan,
  type CommandCommitResult,
} from "@relay/contracts";
import { CommandExecutor, BatchService } from "../../src/batch/batch";
import { KnowledgeService } from "../../src/knowledge/knowledge";
import { TasksService } from "../../src/tasks/tasks";
import { withCommandExecutorDatabase } from "./helpers/command-executor-fixture";
import { expectAsyncRelayError } from "./helpers/entity-fixture";

test("асинхронные загрузки документа не читают полный проект и сохраняют одну атомарную запись", async () => {
  await withCommandExecutorDatabase(async (database) => {
    const selectors: CommandSelector[] = [];
    let commits = 0;
    const initialOutbox = database.getReplicationOutbox().length;
    const delayed: CommandStore = {
      projectId: database.projectId,
      /**
       * Сохраняет настоящий SQL-путь с явно отложенным завершением Promise.
       */
      async load(request: CommandLoadRequest): Promise<CommandLoadResult> {
        await Promise.resolve();
        selectors.push(...request.selectors);
        return database.commands.load(request);
      },
      /**
       * Считает реальные попытки commit после асинхронной границы, не повторяя команду.
       */
      async commit(plan: CommandCommitPlan): Promise<CommandCommitResult> {
        await Promise.resolve();
        commits++;
        return database.commands.commit(plan);
      },
    };

    const result = await new CommandExecutor(delayed).execute(
      {
        op: "document.create",
        input: { name: "Точный документ", body: "Первая строка\r\nВторая без LF" },
      },
      { actor: "автор" },
    );

    expect(commits).toBe(1);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]).toMatchObject({
      kind: "document",
      data: { name: "Точный документ", body: "Первая строка\r\nВторая без LF" },
    });
    expect(
      selectors.some((selector) => selector.kind === "kind" || selector.kind === "task-graph"),
    ).toBe(false);
    expect(database.getReplicationOutbox()).toHaveLength(initialOutbox + 1);
    const document = result.entities[0];
    if (document === undefined || document.kind !== "document") {
      throw new Error("Исполнитель должен вернуть созданный документ");
    }
    expect(result.items[0]?.id).toBe(document.id);
    expect(new KnowledgeService(database).get("document", document.id)).toEqual(document);
  });
});

test("поздний конкурентный commit отклоняет исходный CAS без пересчёта пользовательской мутации", async () => {
  await withCommandExecutorDatabase(async (database, competitor) => {
    const knowledge = new KnowledgeService(database);
    const other = new KnowledgeService(competitor);
    const original = await knowledge.create(
      "document",
      { name: "Исходный", body: "До изменений" },
      "автор",
    );
    const initialOutbox = database.getReplicationOutbox().length;
    let commits = 0;
    const barrier: CommandStore = {
      projectId: database.projectId,
      /**
       * Делегирует загрузки реальному согласованному SQLite-порту.
       */
      load(request: CommandLoadRequest): Promise<CommandLoadResult> {
        return database.commands.load(request);
      },
      /**
       * Коммитит конкурента после расчёта исходного плана, затем применяет его исходные guards.
       */
      async commit(plan: CommandCommitPlan): Promise<CommandCommitResult> {
        commits++;
        await other.update(
          "document",
          original.id,
          { body: "Принятая конкурентная версия" },
          { actor: "другой", ifRevision: original.revision },
        );
        return database.commands.commit(plan);
      },
    };
    let failure: unknown;

    try {
      await new CommandExecutor(barrier).execute(
        {
          op: "document.update",
          ref: original.id,
          ifRevision: original.revision,
          input: { body: "Отвергнутая версия" },
        },
        { actor: "автор", operationKey: "stale-prepared" },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(RelayError);
    if (!(failure instanceof RelayError)) {
      throw new Error("Ожидался предметный конкурентный отказ");
    }
    expect(["COMMAND_CONTEXT_CHANGED", "REVISION_CONFLICT"]).toContain(failure.code);
    expect(commits).toBe(1);
    expect(knowledge.get("document", original.id)).toMatchObject({
      revision: original.revision + 1,
      data: { body: "Принятая конкурентная версия" },
      updatedBy: "другой",
    });
    expect(database.getBatchReceipt("stale-prepared")).toBeUndefined();
    expect(database.getReplicationOutbox()).toHaveLength(initialOutbox + 1);
  });
});

test("изменение независимого документа после подготовки не заменяет узкие guards глобальным CAS", async () => {
  await withCommandExecutorDatabase(async (database, competitor) => {
    const knowledge = new KnowledgeService(database);
    const first = await knowledge.create(
      "document",
      { name: "Первый", body: "Первый до" },
      "автор",
    );
    const second = await knowledge.create(
      "document",
      { name: "Второй", body: "Второй до" },
      "автор",
    );
    const barrier: CommandStore = {
      projectId: database.projectId,
      /**
       * Получает настоящие ограниченные контексты без подмены выбранных данных.
       */
      load(request: CommandLoadRequest): Promise<CommandLoadResult> {
        return database.commands.load(request);
      },
      /**
       * Меняет независимого владельца в точном окне между подготовкой и commit.
       */
      async commit(plan: CommandCommitPlan): Promise<CommandCommitResult> {
        await new KnowledgeService(competitor).update(
          "document",
          second.id,
          { body: "Второй после" },
          { actor: "другой", ifRevision: second.revision },
        );
        return database.commands.commit(plan);
      },
    };

    const result = await new CommandExecutor(barrier).execute(
      {
        op: "document.update",
        ref: first.id,
        ifRevision: first.revision,
        input: { body: "Первый после" },
      },
      { actor: "автор" },
    );

    expect(result.entities[0]).toMatchObject({
      id: first.id,
      revision: first.revision + 1,
      data: { body: "Первый после" },
    });
    expect(knowledge.get("document", second.id).data.body).toBe("Второй после");
  });
});

test("append после подготовки правки содержания сохраняется и входит в первоначальную receipt", async () => {
  await withCommandExecutorDatabase(async (database, competitor) => {
    const tasks = new TasksService(database);
    const task = await tasks.create({ title: "До правки" }, "автор");
    const barrier: CommandStore = {
      projectId: database.projectId,
      /**
       * Загружает исходное содержание через настоящий adapter.
       */
      load(request: CommandLoadRequest): Promise<CommandLoadResult> {
        return database.commands.load(request);
      },
      /**
       * Дописывает журнал другим соединением перед CAS содержания.
       */
      async commit(plan: CommandCommitPlan): Promise<CommandCommitResult> {
        await new TasksService(competitor).comment(
          task.id,
          "Независимый комментарий",
          "наблюдатель",
        );
        return database.commands.commit(plan);
      },
    };

    const result = await new CommandExecutor(barrier).execute(
      {
        op: "task.update",
        ref: task.id,
        ifRevision: task.revision,
        input: { title: "После правки" },
      },
      { actor: "автор", operationKey: "content-with-comment" },
    );

    expect(tasks.get(task.id)).toMatchObject({
      revision: task.revision + 1,
      data: {
        title: "После правки",
        comments: [{ body: "Независимый комментарий", createdBy: "наблюдатель" }],
      },
    });
    expect(result.entities[0]).toEqual(tasks.get(task.id));
    expect(new CommandExecutor(database).getResult("content-with-comment").entities).toEqual(
      result.entities,
    );
  });
});

test("два append из одной прочитанной ревизии не конфликтуют из-за нового head журнала", async () => {
  await withCommandExecutorDatabase(async (database, competitor) => {
    const tasks = new TasksService(database);
    const task = await tasks.create({ title: "Общее обсуждение" }, "автор");
    const barrier: CommandStore = {
      projectId: database.projectId,
      /**
       * Делегирует исходную загрузку комментария настоящему SQLite.
       */
      load(request: CommandLoadRequest): Promise<CommandLoadResult> {
        return database.commands.load(request);
      },
      /**
       * Создаёт поздний append, не изменяя подготовленные ID и поля первого комментария.
       */
      async commit(plan: CommandCommitPlan): Promise<CommandCommitResult> {
        await new TasksService(competitor).comment(task.id, "Другой комментарий", "второй");
        return database.commands.commit(plan);
      },
    };

    const result = await new CommandExecutor(barrier).execute(
      { op: "task.comment.add", ref: task.id, input: { body: "Подготовленный комментарий" } },
      { actor: "первый" },
    );

    const saved = tasks.get(task.id);
    expect(saved.revision).toBe(task.revision);
    expect(saved.data.comments).toHaveLength(2);
    expect(saved.data.comments.map((entry) => [entry.body, entry.createdBy])).toEqual([
      ["Другой комментарий", "второй"],
      ["Подготовленный комментарий", "первый"],
    ]);
    expect(new Set(saved.data.comments.map((entry) => entry.id)).size).toBe(2);
    expect(result.entities[0]).toEqual(saved);
  });
});

test("content commit перед prepared append сохраняет актуальную карточку и первоначальную receipt без content dependency", async () => {
  await withCommandExecutorDatabase(async (database, competitor) => {
    const tasks = new TasksService(database);
    const task = await tasks.create({ title: "Заголовок при подготовке" }, "создатель");
    const creationChangesetId = database.getReplicationOutbox().at(-1)?.id;
    let attempts = 0;
    let preparedCommentId: string | undefined;
    let contentChangesetId: string | undefined;
    const barrier: CommandStore = {
      projectId: database.projectId,
      /**
       * Оставляет реальное чтение существования и содержания, без фиктивного снимка.
       */
      load(request: CommandLoadRequest): Promise<CommandLoadResult> {
        return database.commands.load(request);
      },
      /**
       * Меняет содержание другим соединением после расчёта append, сохраняя исходный план.
       */
      async commit(plan: CommandCommitPlan): Promise<CommandCommitResult> {
        attempts++;
        const comment = plan.transitions
          .flatMap((transition) => transition.effects)
          .find((effect) => effect.kind === "comment");
        if (comment?.kind !== "comment") {
          throw new Error("Подготовленный план не содержит комментарий");
        }
        preparedCommentId = comment.comment.id;
        expect(plan.freshTaskIds).toEqual([task.id]);
        await new TasksService(competitor).update(
          task.id,
          { title: "Заголовок победившего редактора" },
          { actor: "редактор", ifRevision: task.revision },
        );
        contentChangesetId = competitor.getReplicationOutbox().at(-1)?.id;
        return database.commands.commit(plan);
      },
    };

    const result = await new CommandExecutor(barrier).execute(
      { op: "task.comment.add", ref: task.key, input: { body: "Исходный комментарий" } },
      { actor: "комментатор", operationKey: "comment-after-content" },
    );

    const current = tasks.get(task.id);
    if (preparedCommentId === undefined || creationChangesetId === undefined) {
      throw new Error("Создание владельца и исходный ID комментария должны быть известны");
    }
    expect(attempts).toBe(1);
    expect(current).toMatchObject({
      revision: task.revision + 1,
      updatedBy: "редактор",
      data: {
        title: "Заголовок победившего редактора",
        comments: [
          { id: preparedCommentId, body: "Исходный комментарий", createdBy: "комментатор" },
        ],
      },
    });
    expect(current.data.comments).toHaveLength(1);
    expect(result.entities[0]).toEqual(current);
    expect(result.items[0]).toMatchObject({
      id: preparedCommentId,
      revision: current.revision,
      owner: { id: task.id, key: current.key, revision: current.revision },
    });
    const appended = database.getReplicationOutbox().at(-1);
    if (appended === undefined || contentChangesetId === undefined) {
      throw new Error("Обе реальные транзакции должны иметь outbox");
    }
    expect(appended.dependencies).not.toContain(contentChangesetId);
    expect(appended.dependencies).toContain(creationChangesetId);
    expect(
      appended.readContext.some((entry) => entry.id === task.id && entry.kind === "existence"),
    ).toBe(true);
    expect(
      appended.readContext
        .filter((entry) => entry.id === task.id)
        .every((entry) => entry.kind === "existence"),
    ).toBe(true);
    await tasks.update(
      task.id,
      { title: "Изменение после ответа" },
      { actor: "поздний", ifRevision: current.revision },
    );
    expect(new CommandExecutor(database).getResult("comment-after-content")).toEqual({
      ...result,
      replayed: true,
    });
  });
});

test("append не снимает исходный CAS последующего content no-op в том же пакете", async () => {
  await withCommandExecutorDatabase(async (database, competitor) => {
    const tasks = new TasksService(database);
    const task = await tasks.create({ title: "Проверяемый no-op" }, "автор");
    const initialOutbox = database.getReplicationOutbox().length;
    let attempts = 0;
    const barrier: CommandStore = {
      projectId: database.projectId,
      /**
       * Сохраняет оба настоящих контекста — append-existence и последующий content guard.
       */
      load(request: CommandLoadRequest): Promise<CommandLoadResult> {
        return database.commands.load(request);
      },
      /**
       * Меняет заголовок после проверки no-op, делая исходный пользовательский CAS устаревшим.
       */
      async commit(plan: CommandCommitPlan): Promise<CommandCommitResult> {
        attempts++;
        await new TasksService(competitor).update(
          task.id,
          { title: "Победившая правка" },
          { actor: "другой", ifRevision: task.revision },
        );
        return database.commands.commit(plan);
      },
    };

    await expectAsyncRelayError(
      () =>
        new BatchService(barrier).execute(
          {
            version: 1,
            operations: [
              { op: "task.comment.add", ref: task.id, input: { body: "Откатить append" } },
              {
                op: "task.update",
                ref: task.id,
                ifRevision: task.revision,
                input: { title: task.data.title },
              },
            ],
          },
          { actor: "автор", operationKey: "comment-and-stale-noop" },
        ),
      "COMMAND_CONTEXT_CHANGED",
    );

    expect(attempts).toBe(1);
    expect(tasks.get(task.id)).toMatchObject({
      revision: task.revision + 1,
      data: { title: "Победившая правка", comments: [] },
    });
    expect(database.getBatchReceipt("comment-and-stale-noop")).toBeUndefined();
    expect(database.getReplicationOutbox()).toHaveLength(initialOutbox + 1);
  });
});

test("выделение ключа batch учитывает виртуальные адреса прежних шагов только нужного вида", async () => {
  await withCommandExecutorDatabase(async (database) => {
    const initialOutbox = database.getReplicationOutbox().length;

    const result = await new BatchService(database).execute(
      {
        version: 1,
        operations: [
          { op: "application.create", input: { name: "Первое", slug: "first", prefix: "APP-2" } },
          { op: "application.create", input: { name: "Второе", slug: "second", prefix: "DOC-1" } },
          {
            op: "document.create",
            input: { name: "Самостоятельный ключ", body: "DOC-1 разрешён виду document" },
          },
        ],
      },
      { actor: "автор", operationKey: "overlay-virtual-addresses" },
    );

    expect(result.items.map((item) => item.key)).toEqual(["APP-1", "APP-3", "DOC-1"]);
    const application = new KnowledgeService(database).get("application", "APP-2");
    expect(result.items[0]?.id).toBe(application.id);
    expect(application.data.prefix).toBe("APP-2");
    expect(database.getIdentity("APP-2")).toBeUndefined();
    expect(database.getReplicationOutbox()).toHaveLength(initialOutbox + 1);
  });
});

test("изменение caller options после вызова не превращает выполняющийся check в apply", async () => {
  await withCommandExecutorDatabase(async (database) => {
    const input = { name: "Исходный", body: "Исходное содержание" };
    const options = { actor: "первый", operationKey: "check-snapshot", check: true };
    const generation = database.getGeneration();
    const pending = new BatchService(database).execute(
      { version: 1, operations: [{ op: "document.create", input }] },
      options,
    );

    options.check = false;
    options.actor = "второй";
    input.body = "Не принадлежит исходному вызову";
    const result = await pending;

    expect(result.status).toBe("checked");
    expect(result.entities[0]).toMatchObject({
      createdBy: "первый",
      data: { body: "Исходное содержание" },
    });
    expect(database.count("document")).toBe(0);
    expect(database.getGeneration()).toBe(generation);
    expect(database.getBatchReceipt("check-snapshot")).toBeUndefined();
  });
});

test("адресные условия копируются до async receipt lookup и не подменяются caller мутацией", async () => {
  await withCommandExecutorDatabase(async (database) => {
    const knowledge = new KnowledgeService(database);
    const document = await knowledge.create(
      "document",
      { name: "Цель", body: "Сохранить" },
      "автор",
    );
    const other = await knowledge.create(
      "document",
      { name: "Другой ID", body: "Другой" },
      "автор",
    );
    const expected = { ref: document.key, expectedId: other.id };
    const pending = new CommandExecutor(database).execute(
      {
        op: "document.update",
        ref: document.key,
        ifRevision: document.revision,
        input: { body: "Не применять" },
      },
      { actor: "автор", operationKey: "guard-input-snapshot", expectedAddresses: [expected] },
    );

    expected.expectedId = document.id;
    await expectAsyncRelayError(() => pending, "ADDRESS_CHANGED");

    expect(knowledge.get("document", document.id)).toEqual(document);
    expect(database.getBatchReceipt("guard-input-snapshot")).toBeUndefined();
  });
});

test("непредставимый UTF-8 ключ receipt отклоняется до записи, а текст документа сохраняет lone surrogate", async () => {
  await withCommandExecutorDatabase(async (database) => {
    const batch = new BatchService(database);
    const input = {
      version: 1,
      operations: [
        { op: "document.create", input: { name: "Точный текст", body: "До\ud800после" } },
      ],
    };
    const generation = database.getGeneration();
    const outbox = database.getReplicationOutbox();

    await expectAsyncRelayError(
      () => batch.execute(input, { actor: "автор", operationKey: "receipt-\ud800" }),
      "INVALID_ARGUMENT",
    );

    expect(database.count("document")).toBe(0);
    expect(database.getGeneration()).toBe(generation);
    expect(database.getReplicationOutbox()).toEqual(outbox);
    const result = await batch.execute(input, { actor: "автор", operationKey: "receipt-valid" });
    expect(result.entities[0]).toMatchObject({ data: { body: "До\ud800после" } });
    expect(batch.getResult("receipt-valid").entities).toEqual(result.entities);
  });
});
