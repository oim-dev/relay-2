import {
  inputArgs,
  integer,
  pageArgs,
  positional,
  refArgs,
  repeated,
  remapInput,
  string,
  textArgs,
} from "../arguments";
import {
  type CommandRegistry,
  type Invocation,
  findItem,
  records,
  references,
  result,
} from "../registry";

function planningInput(i: Invocation): Record<string, unknown> {
  const input = remapInput(i.input, { plans: "planIds", releaseVersion: "version" });
  if (Array.isArray(input.scope))
    input.scope = input.scope.map((ref) => {
      if (typeof ref !== "string") return ref;
      const entity = i.queries.get(ref);
      return { kind: entity.kind, id: entity.id };
    });
  return input;
}

export function registerPlanningCommands(registry: CommandRegistry): void {
  for (const [command, kind] of [
    ["plan", "work-plan"],
    ["release", "release"],
  ] as const) {
    registry.group(command, command === "plan" ? "Планы работы и этапы" : "Релизы");
    registry.add(`${command} list`, {
      description: command === "plan" ? "Список планов" : "Список релизов",
      args: pageArgs,
      fields: { q: string("Поиск по содержанию"), status: string("Состояние") },
      run: (i) =>
        i.entities(
          (i.input.q ? i.queries.search({ q: i.input.q, kind }) : i.planning.list(kind)).filter(
            (entity) => !i.input.status || entity.data.status === i.input.status,
          ),
        ),
    });
    registry.add(`${command} get`, {
      description: "Полное содержание и ревизия",
      args: refArgs,
      run: (i) => result(i.planning.get(kind, i.text("ref"))),
    });
    const fields = inputArgs(
      {
        title: string("Заголовок"),
        ...textArgs("summary"),
        ...(kind === "work-plan"
          ? {
              ...textArgs("goal", "rationale", "boundaries", "expected-result"),
              scope: repeated("Предметная область"),
              participants: repeated("Участник"),
            }
          : {
              ...textArgs("description"),
              plans: repeated("План релиза"),
              "release-version": string("Версия выпуска"),
              "planned-for": string("Дата выпуска YYYY-MM-DD"),
            }),
      },
      kind === "release" ? ["planIds", "version"] : [],
    );
    registry.add(`${command} create`, {
      description: "Создать план или релиз",
      mode: "create",
      fields,
      run: (i) => result(i.planning.create(kind, planningInput(i), i.actor)),
    });
    registry.add(`${command} update`, {
      description: "Изменить переданные поля",
      mode: "update",
      args: refArgs,
      fields,
      run: (i) => result(i.planning.update(kind, i.text("ref"), planningInput(i), i.write)),
    });
    registry.add(`${command} progress`, {
      description: "Фактическая готовность полного состава",
      args: refArgs,
      run: (i) => result(i.planning.progress(kind, i.text("ref"))),
    });
    for (const action of kind === "work-plan"
      ? ["start", "complete", "cancel"]
      : ["plan", "publish", "cancel"])
      registry.add(`${command} ${action}`, {
        description: `Переход состояния: ${action}`,
        mode: "update",
        args: refArgs,
        fields: kind === "work-plan" && action !== "start" ? inputArgs(textArgs("result")) : {},
        run: (i) => result(i.planning.transition(kind, i.text("ref"), action, i.input, i.write)),
      });
  }
  registry.group("plan stage", "Этапы; ревизия относится к плану");
  registry.add("plan stage list", {
    description: "Этапы в заданном порядке",
    args: { ...refArgs, ...pageArgs },
    run: (i) => {
      const plan = i.planning.get("work-plan", i.text("ref"));
      return i.page(records(plan.data.stages), { plan: plan.key, revision: plan.revision });
    },
  });
  registry.add("plan stage get", {
    description: "Полный этап и ревизия плана",
    args: { ...refArgs, stage: positional("ID этапа") },
    run: (i) => {
      const plan = i.planning.get("work-plan", i.text("ref"));
      return result({
        plan: plan.key,
        revision: plan.revision,
        stage: findItem(records(plan.data.stages), i.text("stage"), "Этап"),
      });
    },
  });
  for (const action of ["create", "update", "move", "remove"])
    registry.add(`plan stage ${action}`, {
      description: {
        create: "Создать этап",
        update: "Изменить этап",
        move: "Переместить этап",
        remove: "Удалить пустой этап",
      }[action]!,
      mode: "update",
      args: { ...refArgs, ...(action === "create" ? {} : { stage: positional("ID этапа") }) },
      fields:
        action === "create" || action === "update"
          ? inputArgs({
              title: string("Заголовок"),
              ...textArgs("summary", "outcome", "completion-conditions"),
              ...(action === "create"
                ? { before: string("Вставить перед этапом; без параметра — в конец") }
                : {}),
            })
          : action === "move"
            ? { before: string("Перед этапом; без параметра — в конец") }
            : {},
      run: (i) =>
        result(
          i.planning.stage(
            i.text("ref"),
            action,
            {
              ...(action === "move" ? { before: null } : {}),
              ...i.input,
              ...(action === "create" ? {} : { stageId: i.text("stage") }),
            },
            i.write,
          ),
        ),
    });
  registry.group("plan stage task", "Явный состав этапа");
  registry.add("plan stage task list", {
    description: "Задачи этапа",
    args: { ...refArgs, stage: positional("ID этапа"), ...pageArgs },
    run: (i) => {
      const plan = i.planning.get("work-plan", i.text("ref"));
      const stage = findItem(records(plan.data.stages), i.text("stage"), "Этап");
      return i.page(
        references(stage.taskIds).map((ref) => i.tasks.get(ref)),
        { plan: plan.key, revision: plan.revision },
      );
    },
  });
  for (const remove of [false, true])
    registry.add(`plan stage task ${remove ? "remove" : "add"}`, {
      description: remove ? "Исключить задачу из этапа" : "Включить задачу в этап",
      mode: "update",
      args: { ...refArgs, stage: positional("ID этапа"), task: positional("Задача") },
      run: (i) =>
        result(
          i.planning.stageTask(i.text("ref"), i.text("stage"), i.text("task"), remove, i.write),
        ),
    });
  registry.add("plan stage task transfer", {
    description: "Атомарно перенести задачу между этапами или планами",
    mode: "update",
    args: {
      ...refArgs,
      task: positional("Переносимая задача"),
      stage: positional("ID целевого этапа"),
      "target-plan": string("Целевой план", true),
      "target-revision": { ...integer("Прочитанная ревизия целевого плана", 1), required: true },
    },
    fields: textArgs("reason"),
    run: (i) =>
      result(
        i.planning.transfer(
          i.text("ref"),
          {
            ...i.input,
            task: i.text("task"),
            targetPlan: i.text("target-plan"),
            targetStage: i.text("stage"),
          },
          { ...i.write, targetRevision: Number(i.values["target-revision"]) },
        ),
      ),
  });
  registry.group("plan task", "Участие задач в планах");
  registry.add("plan task memberships", {
    description: "Этапы, содержащие задачу",
    args: { ...refArgs, ...pageArgs },
    run: (i) => {
      const task = i.tasks.get(i.text("ref"));
      return i.page(
        i.planning.list("work-plan").flatMap((plan) =>
          records(plan.data.stages)
            .filter((stage) => references(stage.taskIds).includes(task.id))
            .map((stage) => ({ plan: plan.key, revision: plan.revision, stage })),
        ),
        { task: task.key },
      );
    },
  });
  registry.add("release plans", {
    description: "Планы в составе релиза",
    args: { ...refArgs, ...pageArgs },
    run: (i) => {
      const release = i.planning.get("release", i.text("ref"));
      return i.page(
        references(release.data.planIds).map((ref) => i.planning.get("work-plan", ref)),
        { release: release.key, revision: release.revision },
      );
    },
  });
}
