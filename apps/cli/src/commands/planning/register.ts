import type { StageChange } from "@relay/contracts";
import type { Args } from "gunshi";
import {
  inputArgs,
  integer,
  pageArgs,
  positional,
  refArgs,
  repeated,
  string,
  textArgs,
} from "../../input/arguments";
import { remapInput } from "../../input/input";
import { planningCommandMessages as messages } from "../../locales/commands/planning";
import { result } from "../../output/output";
import type { Result } from "../../output/output.types";
import type { CommandRegistry } from "../../execution/registry";
import type { Invocation } from "../../execution/invocation";

/**
 * Возвращает копию внешнего ввода с именами полей Core и развёрнутыми ссылками scope.
 * Строковый синтаксис ссылок разрешается через общий QueryService в транзакции команды;
 * JSON-объекты и неверные формы передаются предметному валидатору Core без подмены.
 * Конфликт алиасов и ошибка разрешения ссылки прерывают команду до записи.
 */
function planningInput(i: Invocation): Record<string, unknown> {
  const input = remapInput(i.input, { plans: "planIds", releaseVersion: "version" });
  if (Array.isArray(input.scope)) {
    input.scope = input.scope.map((ref: unknown) => {
      if (typeof ref !== "string") {
        return ref;
      }
      const entity = i.queries.get(ref);
      return { kind: entity.kind, id: entity.id };
    });
  }
  return input;
}

/**
 * Возвращает схему CLI для операции с этапом; отсутствие --before означает конец списка.
 * Удаление не принимает полей, создание дополнительно разрешает позицию вставки.
 */
function planStageFields(action: StageChange["action"]): Args {
  if (action === "create" || action === "update") {
    return inputArgs({
      title: string(messages.fields.title),
      ...textArgs({
        summary: messages.fields.summary,
        outcome: messages.fields.outcome,
        "completion-conditions": messages.fields.completionConditions,
      }),
      ...(action === "create" ? { before: string(messages.fields.insertBefore) } : {}),
    });
  }
  if (action === "move") {
    return { before: string(messages.fields.moveBefore) };
  }
  return {};
}

/**
 * Добавляет команды планирования в реестр без чтения проекта.
 * Предметные проверки, ревизии и запись принадлежат Core; реестр обеспечивает общую
 * транзакцию изменения либо согласованный снимок составного чтения.
 */
export function registerPlanningCommands(registry: CommandRegistry): void {
  for (const [command, kind] of [
    ["plan", "work-plan"],
    ["release", "release"],
  ] as const) {
    const help = messages.entities[command];
    registry.group(command, help.group);
    registry.add(`${command} list`, {
      ...help.list,
      args: pageArgs,
      fields: { q: string(messages.fields.query), status: string(messages.fields.status) },
      /**
       * Возвращает страницу планов или релизов по ключу; фильтрацию выполняет Core.
       */
      run: (i): Result =>
        i.page((window) => i.planning.listPage(kind, i.input, { ...window, sort: "key" })),
    });
    registry.add(`${command} get`, {
      ...help.get,
      args: refArgs,
      /**
       * Возвращает полную запись планирования по ссылке, разрешённой Core.
       */
      run: (i): Result => result(i.planning.get(kind, i.text("ref"))),
    });
    const fields = inputArgs(
      {
        title: string(messages.fields.title),
        ...textArgs({ summary: messages.fields.summary }),
        ...(kind === "work-plan"
          ? {
              ...textArgs({
                goal: messages.fields.goal,
                rationale: messages.fields.rationale,
                boundaries: messages.fields.boundaries,
                "expected-result": messages.fields.expectedResult,
              }),
              scope: repeated(messages.fields.scope),
              participants: repeated(messages.fields.participant),
            }
          : {
              ...textArgs({ description: messages.fields.releaseDescription }),
              plans: repeated(messages.fields.releasePlan),
              "release-version": string(messages.fields.releaseVersion),
              "planned-for": string(messages.fields.plannedFor),
            }),
      },
      kind === "release" ? ["planIds", "version"] : [],
    );
    registry.add(`${command} create`, {
      ...help.create,
      mode: "create",
      fields,
      /**
       * Возвращает атомарно созданную запись после преобразования синтаксиса полей CLI.
       */
      run: (i): Result => result(i.planning.create(kind, planningInput(i), i.actor)),
    });
    registry.add(`${command} update`, {
      ...help.update,
      mode: "update",
      args: refArgs,
      fields,
      /**
       * Возвращает изменённую запись; Core проверяет ревизию плана или релиза до no-op.
       */
      run: (i): Result => result(i.planning.update(kind, i.text("ref"), planningInput(i), i.write)),
    });
    registry.add(`${command} progress`, {
      ...help.progress,
      args: refArgs,
      /**
       * Возвращает готовность полного состава, рассчитанную Core в снимке команды.
       */
      run: (i): Result => result(i.planning.progress(kind, i.text("ref"))),
    });
    const transitions =
      kind === "work-plan"
        ? ([
            ["start", messages.entities.plan.transitions.start],
            ["complete", messages.entities.plan.transitions.complete],
            ["cancel", messages.entities.plan.transitions.cancel],
          ] as const)
        : ([
            ["plan", messages.entities.release.transitions.plan],
            ["publish", messages.entities.release.transitions.publish],
            ["cancel", messages.entities.release.transitions.cancel],
          ] as const);
    for (const [action, transitionHelp] of transitions) {
      registry.add(`${command} ${action}`, {
        ...transitionHelp,
        mode: "update",
        args: refArgs,
        fields:
          kind === "work-plan" && action !== "start"
            ? inputArgs(textArgs({ result: messages.fields.result }))
            : {},
        /**
         * Возвращает запись после перехода; Core атомарно проверяет её ревизию и готовность.
         * Возможность no-op определяется предметным переходом, а не обработчиком CLI.
         */
        run: (i): Result =>
          result(i.planning.transition(kind, i.text("ref"), action, i.input, i.write)),
      });
    }
  }
  registry.group("plan stage", messages.stage);
  registry.add("plan stage list", {
    ...messages.stageList,
    args: { ...refArgs, ...pageArgs },
    /**
     * Возвращает страницу полного списка этапов с ревизией плана из одного снимка.
     */
    run: (i): Result => {
      const { items, ...owner } = i.planning.listStages(i.text("ref"));
      return i.page(items, owner);
    },
  });
  registry.add("plan stage get", {
    ...messages.stageGet,
    args: { ...refArgs, stage: positional(messages.fields.stageId) },
    /**
     * Возвращает этап с ревизией содержащего его плана из снимка команды.
     */
    run: (i): Result => result(i.planning.getStage(i.text("ref"), i.text("stage"))),
  });
  for (const action of ["create", "update", "move", "remove"] as const) {
    registry.add(`plan stage ${action}`, {
      ...messages.stageActions[action],
      mode: "update",
      args: {
        ...refArgs,
        ...(action === "create" ? {} : { stage: positional(messages.fields.stageId) }),
      },
      fields: planStageFields(action),
      /**
       * Возвращает план после изменения этапа под ревизией плана, включая проверку до no-op.
       * Для move отсутствие --before преобразуется в явный конец списка для Core.
       */
      run: (i): Result =>
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
  }
  registry.group("plan stage task", messages.stageTask);
  registry.add("plan stage task list", {
    ...messages.stageTaskList,
    args: { ...refArgs, stage: positional(messages.fields.stageId), ...pageArgs },
    /**
     * После проверки курсора читает только карточки окна задач и ревизию плана в одном снимке.
     */
    run: (i): Result =>
      i.page((window) => {
        const { items, total, ...owner } = i.planning.stageTasksPage(
          i.text("ref"),
          i.text("stage"),
          window,
        );
        return { items, total, owner };
      }),
  });
  for (const remove of [false, true]) {
    registry.add(`plan stage task ${remove ? "remove" : "add"}`, {
      ...(remove ? messages.stageTaskRemove : messages.stageTaskAdd),
      mode: "update",
      args: {
        ...refArgs,
        stage: positional(messages.fields.stageId),
        task: positional(messages.fields.task),
      },
      /**
       * Возвращает план после изменения состава; Core проверяет CAS плана даже при no-op.
       * Содержание и ревизия самой задачи не меняются.
       */
      run: (i): Result =>
        result(
          i.planning.stageTask(i.text("ref"), i.text("stage"), i.text("task"), remove, i.write),
        ),
    });
  }
  registry.add("plan stage task transfer", {
    ...messages.stageTaskTransfer,
    mode: "update",
    args: {
      ...refArgs,
      task: positional(messages.fields.transferredTask),
      stage: positional(messages.fields.targetStageId),
      "target-plan": string(messages.fields.targetPlan, true),
      "target-revision": { ...integer(messages.fields.targetRevision, 1), required: true },
    },
    fields: textArgs({ reason: messages.fields.reason }),
    /**
     * Возвращает исходный и целевой планы после атомарного переноса включения задачи.
     * Обе переданные ревизии проверяются Core, в том числе для одного плана и no-op.
     */
    run: (i): Result =>
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
  registry.group("plan task", messages.task);
  registry.add("plan task memberships", {
    ...messages.memberships,
    args: { ...refArgs, ...pageArgs },
    /**
     * Возвращает страницу полного набора включений задачи, рассчитанного Core в одном снимке.
     */
    run: (i): Result => {
      const { items, ...owner } = i.planning.memberships(i.text("ref"));
      return i.page(items, owner);
    },
  });
  registry.add("release plans", {
    ...messages.releasePlans,
    args: { ...refArgs, ...pageArgs },
    /**
     * После проверки курсора читает только карточки окна планов и ревизию релиза в одном снимке.
     */
    run: (i): Result =>
      i.page((window) => {
        const { items, total, ...owner } = i.planning.releasePlansPage(i.text("ref"), window);
        return { items, total, owner };
      }),
  });
}
