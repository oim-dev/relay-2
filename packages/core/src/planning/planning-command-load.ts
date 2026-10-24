import {
  PLAN_SCOPE_KINDS,
  RelayError,
  type EntityRecord,
  type EntityIdentity,
  type PlanningKind,
  type WorkPlanRecord,
} from "@relay/contracts";
import type { CommandContext } from "../commands/command-context";
import { decodePlan } from "./planning-data";
import { parsePlanCommandInput, parsePlanFields, parseReleaseFields } from "./planning-input";
import { choice, reference } from "./planning-validation";
import { planTaskIds } from "./planning-progress";
import { planningMessages } from "./planning.messages";
import type {
  PlanningCreationAllocation,
  PlanningFieldsContext,
  PlanningMembershipContext,
} from "./planning-command.types";

/**
 * Загружает только переданные scope/planIds. Строковые CLI-ссылки разрешаются здесь
 * с адресными guards, до строгого pure parser; post-resolve дубли проверяет calculator.
 */
export async function loadPlanningFields(
  commands: CommandContext,
  kind: PlanningKind,
  input: unknown,
): Promise<PlanningFieldsContext> {
  if (kind === "release") {
    const fields = parseReleaseFields(input);
    const plans = await loadReleasePlans(commands, fields.planIds ?? []);
    return { kind, fields, plans };
  }
  const checked = parsePlanCommandInput(input);
  const normalized: unknown[] = [];
  if (Array.isArray(checked.scope)) {
    for (const entry of checked.scope) {
      if (typeof entry === "string") {
        const target = await commands.resolve(entry);
        normalized.push({
          kind: choice(target.kind, PLAN_SCOPE_KINDS, "scope.kind"),
          id: target.id,
        });
      } else {
        normalized.push(entry);
      }
    }
  }
  const fields = parsePlanFields({
    ...checked,
    ...(checked.scope === undefined ? {} : { scope: normalized }),
  });
  const scope: EntityIdentity[] = [];
  for (const entry of fields.scope ?? []) {
    scope.push(await commands.resolve(entry.id, entry.kind));
  }
  return { kind, fields, scope };
}

/**
 * Загружает выбранные планы последовательно в исходном порядке. При отказе не остаётся
 * выполняющихся sibling-чтений, которые могли бы пережить cleanup владельца соединения.
 */
export async function loadReleasePlans(
  commands: CommandContext,
  refs: readonly string[],
): Promise<WorkPlanRecord[]> {
  const plans: WorkPlanRecord[] = [];
  for (const ref of refs) {
    plans.push(
      decodePlan(await commands.get(reference(ref, "ref"), "work-plan"), commands.projectId),
    );
  }
  return plans;
}

/**
 * Выделяет стабильные метаданные до calculator и защищает отсутствие нового ID.
 * Коллизия ещё не закреплённого кандидата допускает ограниченный выбор нового UUID.
 */
export async function allocatePlanningCreation(
  commands: CommandContext,
  kind: PlanningKind,
): Promise<PlanningCreationAllocation> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const id = commands.allocateId();
    if ((await commands.identity(id)) === null) {
      return {
        id,
        key: await commands.key(kind, kind === "work-plan" ? "PLN" : "REL"),
        actor: commands.actor,
        timestamp: commands.timestamp,
        projectId: commands.projectId,
      };
    }
  }
  throw new RelayError("CONFLICT", planningMessages.missingAllocation, 4);
}

/**
 * Загружает задачу и полное множество её включений, включая пустоту/закрытые планы.
 * Повреждение относящегося к задаче owner декодируется, посторонний каталог не читается.
 */
export async function loadPlanningMembership(
  commands: CommandContext,
  taskRef: string,
  includeMemberships: boolean,
): Promise<PlanningMembershipContext> {
  const task = await commands.get(reference(taskRef, "task"), "task");
  const records = includeMemberships ? await commands.memberships(task.id) : [];
  return { task, memberships: records.map((record) => decodePlan(record, commands.projectId)) };
}

/**
 * Загружает одну узкую проекцию графа только для непустого состава перехода готовности.
 */
export async function loadPlanningGraph(
  commands: CommandContext,
  plans: readonly WorkPlanRecord[],
): Promise<EntityRecord[]> {
  return planTaskIds(plans).length === 0 ? [] : commands.graphRecords();
}
