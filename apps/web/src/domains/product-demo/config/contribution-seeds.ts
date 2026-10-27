import type { ProductContribution } from "../types/product-demo.type";
import { getContributionTitle } from "../helpers/get-contribution-title";
import { buildContributionDescription } from "../helpers/build-contribution-description";
import { FEATURE_SCENARIO_SEEDS } from "./scenario-seeds";
import {
  CONTRIBUTION_FEATURE_STATUS_SEEDS,
  CONTRIBUTION_SCENARIO_STATUS_SEEDS,
} from "./contribution-status-seeds";

/** Описания моковых вкладов до добавления исходных состояний. */
type ContributionSeed = Omit<ProductContribution, "status" | "scenarios" | "title"> & {
  /** Выбранные сценарии с описанием ответственности приложения. */
  scenarios: Omit<ProductContribution["scenarios"][number], "status" | "title">[];
};

/** Одни и те же сценарии имеют разные, предметно описанные вклады приложений. */
export const CONTRIBUTION_DETAILS: ContributionSeed[] = [
  {
    featureId: "catalog",
    applicationId: "web",
    description:
      "Дать арендатору понятный интерфейс поиска и выбора вещи: от запроса до подробных условий аренды.",
    scenarios: [
      {
        scenarioId: "catalog-search",
        description:
          "Показать поле поиска, список результатов и состояние без совпадений. Сохранять запрос при возвращении из карточки. При ошибке предложить повторить поиск.",
      },
      {
        scenarioId: "catalog-filters",
        description:
          "Дать выбрать категорию, диапазон цены и свободные даты. Показывать применённые фильтры и позволять сбросить их одним действием.",
      },
      {
        scenarioId: "catalog-card",
        description:
          "Показать фотографии, характеристики, цену и правила владельца. Поддержать прямую ссылку и переход к выбору периода аренды.",
      },
    ],
  },
  {
    featureId: "catalog",
    applicationId: "api",
    description:
      "Обеспечить поиск только доступных и одобренных вещей. Проверять параметры и возвращать согласованные данные для каталога и карточки.",
    scenarios: [
      {
        scenarioId: "catalog-search",
        description:
          "Найти объявления по названию и описанию с учётом города запуска. Возвращать результаты постранично и не раскрывать скрытые объявления.",
      },
      {
        scenarioId: "catalog-filters",
        description:
          "Совместно применять категорию, цену и период. Исключать вещи с пересекающимися подтверждёнными бронированиями.",
      },
      {
        scenarioId: "catalog-card",
        description:
          "Возвращать актуальные условия аренды и публичные сведения о владельце. Проверять доступ к контактным данным отдельно.",
      },
      {
        scenarioId: "catalog-sort",
        description:
          "Поддержать сортировку по цене и новизне с устойчивым порядком при равных значениях и переходе между страницами.",
      },
    ],
  },
  {
    featureId: "booking",
    applicationId: "web",
    description:
      "Провести участников через создание, подтверждение и отмену брони с понятным результатом каждого действия.",
    scenarios: [
      {
        scenarioId: "booking-request",
        description:
          "Показать календарь доступности и итоговую стоимость до отправки. Сохранить выбранные даты при ошибке и показать подтверждение приёма заявки.",
      },
      {
        scenarioId: "booking-confirm",
        description:
          "Дать владельцу принять заявку и показать арендатору обновлённое состояние без повторной отправки.",
      },
      {
        scenarioId: "booking-cancel",
        description:
          "Показать условия отмены, запросить причину и обновить историю заявки после подтверждения операции.",
      },
    ],
  },
  {
    featureId: "booking",
    applicationId: "api",
    description:
      "Хранить бронирования и обеспечивать непротиворечивость дат, стоимости и прав участников.",
    scenarios: [
      {
        scenarioId: "booking-request",
        description:
          "Повторно проверить доступность при отправке, рассчитать стоимость и создать одну заявку при повторном запросе.",
      },
      {
        scenarioId: "booking-confirm",
        description:
          "Атомарно подтвердить бронь и исключить пересечения периодов. Разрешать подтверждение только владельцу.",
      },
      {
        scenarioId: "booking-cancel",
        description:
          "Проверить право на отмену, освободить даты и сохранить автора, причину и время изменения.",
      },
    ],
  },
  {
    featureId: "booking",
    applicationId: "admin",
    description:
      "Помочь поддержке разобраться в истории бронирования и выполнить разрешённую отмену от имени сервиса.",
    scenarios: [
      {
        scenarioId: "booking-cancel",
        description:
          "Показать историю и причину обращения, дать сотруднику отменить бронь с обязательным пояснением. Отразить результат операции API.",
      },
    ],
  },
  {
    featureId: "profiles",
    applicationId: "web",
    description: "Дать участнику управлять публичным профилем и находить свои прошлые аренды.",
    scenarios: [
      {
        scenarioId: "profiles-contact",
        description:
          "Предоставить форму имени и фотографии, шаг подтверждения телефона и понятные сообщения об ошибках кода.",
      },
      {
        scenarioId: "profiles-history",
        description:
          "Показать историю завершённых аренд с переходом к подробностям и пустым состоянием для нового участника.",
      },
    ],
  },
  {
    featureId: "profiles",
    applicationId: "api",
    description: "Хранить профиль, подтверждения контактов и ограничивать доступ к личным данным.",
    scenarios: [
      {
        scenarioId: "profiles-contact",
        description:
          "Проверять одноразовый код, ограничивать повторные попытки и выдавать контакт только участникам подтверждённой аренды.",
      },
      {
        scenarioId: "profiles-history",
        description:
          "Возвращать только аренды текущего участника с устойчивой пагинацией и актуальным состоянием.",
      },
    ],
  },
  {
    featureId: "moderation",
    applicationId: "admin",
    description: "Предоставить рабочее место модератора с очередью объявлений и историей решений.",
    scenarios: [
      {
        scenarioId: "moderation-review",
        description:
          "Показать очередь и материалы объявления. Дать одобрить публикацию, сохранив сведения о проверившем сотруднике.",
      },
      {
        scenarioId: "moderation-retry",
        description:
          "Дать указать причину отказа и сравнить исправленное объявление с предыдущей редакцией при повторной проверке.",
      },
    ],
  },
  {
    featureId: "moderation",
    applicationId: "api",
    description:
      "Обеспечить правила переходов объявления между проверкой, публикацией и отклонением.",
    scenarios: [
      {
        scenarioId: "moderation-review",
        description:
          "Проверить роль модератора, записать решение и включить одобренное объявление в выдачу каталога.",
      },
      {
        scenarioId: "moderation-retry",
        description:
          "Хранить причину отказа и редакции объявления. После исправлений создавать новую запись в очереди проверки.",
      },
    ],
  },
  {
    featureId: "moderation",
    applicationId: "web",
    description: "Объяснять владельцу решение модерации и помогать исправить объявление.",
    scenarios: [
      {
        scenarioId: "moderation-retry",
        description:
          "Показать причину отказа в кабинете, дать изменить объявление и отправить его на повторную проверку.",
      },
    ],
  },
  {
    featureId: "ai-chat",
    applicationId: "web",
    description:
      "Дать пользователю подобрать вещи в диалоге с помощником, сохраняя контроль над последующим бронированием.",
    scenarios: [
      {
        scenarioId: "ai-chat-recommend",
        description:
          "Показать ленту сообщений, отправку запроса и потоковый ответ. При сбое сохранить запрос и предложить повторить его.",
      },
      {
        scenarioId: "ai-chat-history",
        description:
          "Показать предыдущие диалоги и восстановить переписку при возвращении пользователя.",
      },
      {
        scenarioId: "ai-chat-open",
        description:
          "Превратить рекомендации в ссылки на карточки. Явно показать недоступную вещь и оставить решение о брони пользователю.",
      },
    ],
  },
  {
    featureId: "ai-chat",
    applicationId: "api",
    description:
      "Обрабатывать диалоги с моделью, хранить историю и подбирать рекомендации из актуального каталога.",
    scenarios: [
      {
        scenarioId: "ai-chat-recommend",
        description:
          "Передать модели контекст запроса и допустимые сведения о вещах, вернуть поток ответа и обработать отказ внешнего сервиса.",
      },
      {
        scenarioId: "ai-chat-history",
        description:
          "Сохранить сообщения по диалогам и разрешать чтение и продолжение только владельцу разговора.",
      },
      {
        scenarioId: "ai-chat-open",
        description:
          "Возвращать постоянные ID рекомендованных вещей и актуальную доступность без обещания бронирования.",
      },
    ],
  },
  {
    featureId: "notifications",
    applicationId: "api",
    description:
      "Создавать уведомления о значимых событиях аренды и предотвращать повторную отправку.",
    scenarios: [
      {
        scenarioId: "notifications-booking",
        description:
          "Формировать одно событие на изменение брони и выдавать его правильным участникам. Хранить отметку прочтения.",
      },
      {
        scenarioId: "notifications-return",
        description:
          "Планировать напоминание по времени окончания аренды, учитывать часовой пояс и отменять его при отмене брони.",
      },
    ],
  },
  {
    featureId: "notifications",
    applicationId: "web",
    description: "Показать участнику важные события и быстрый переход к соответствующей аренде.",
    scenarios: [
      {
        scenarioId: "notifications-booking",
        description:
          "Реализовать центр уведомлений, счётчик непрочитанного, отметку прочтения и переход к бронированию.",
      },
      {
        scenarioId: "notifications-return",
        description:
          "Показать время возврата и ссылку на детали аренды. Объяснять время в часовом поясе пользователя.",
      },
    ],
  },
  {
    featureId: "reviews",
    applicationId: "web",
    description: "Дать участникам делиться опытом аренды и сообщать о нарушениях в отзывах.",
    scenarios: [
      {
        scenarioId: "reviews-write",
        description:
          "Показать форму оценки после завершённой аренды, сохранить ввод при ошибке и отобразить опубликованный отзыв.",
      },
      {
        scenarioId: "reviews-report",
        description:
          "Дать выбрать причину жалобы, добавить пояснение и увидеть подтверждение отправки в поддержку.",
      },
    ],
  },
  {
    featureId: "reviews",
    applicationId: "api",
    description: "Проверять право на отзыв и хранить материалы жалоб с историей решений.",
    scenarios: [
      {
        scenarioId: "reviews-write",
        description:
          "Проверять участие в завершённой аренде и ограничивать число отзывов на одну аренду.",
      },
      {
        scenarioId: "reviews-report",
        description:
          "Принимать жалобы, выдавать очередь поддержке и сохранять решение с автором и временем.",
      },
    ],
  },
  {
    featureId: "reviews",
    applicationId: "admin",
    description: "Предоставить поддержке разбор жалоб на отзывы.",
    scenarios: [
      {
        scenarioId: "reviews-report",
        description:
          "Показать отзыв, жалобу и контекст аренды. Дать сотруднику оставить решение с объяснением.",
      },
    ],
  },
  {
    featureId: "favorites",
    applicationId: "web",
    description: "Дать пользователю сохранить интересные вещи и вернуться к выбору позже.",
    scenarios: [
      {
        scenarioId: "favorites-save",
        description:
          "Добавить действие сохранения в каталог и карточку, показать выбранное состояние и возможность отменить действие.",
      },
      {
        scenarioId: "favorites-list",
        description:
          "Показать личный список и помечать недоступные объявления. Сохранить контекст при переходе к карточке.",
      },
    ],
  },
  {
    featureId: "favorites",
    applicationId: "api",
    description: "Хранить избранное участника между устройствами.",
    scenarios: [
      {
        scenarioId: "favorites-save",
        description:
          "Идемпотентно добавлять и удалять вещь из личного списка. Проверять владельца списка.",
      },
      {
        scenarioId: "favorites-list",
        description:
          "Выдавать сохранённые вещи с их текущей доступностью и поддерживать пагинацию.",
      },
    ],
  },
  {
    featureId: "deposit",
    applicationId: "api",
    description: "Хранить сведения о залоге, подтверждениях передачи и рассмотрении спора.",
    scenarios: [
      {
        scenarioId: "deposit-record",
        description:
          "Сохранить согласованную сумму, подтверждения участников и материалы о состоянии вещи с проверкой доступа.",
      },
      {
        scenarioId: "deposit-dispute",
        description:
          "Хранить обращение, материалы и решение поддержки. Обеспечить аудит изменений.",
      },
    ],
  },
  {
    featureId: "deposit",
    applicationId: "admin",
    description: "Дать поддержке принять обоснованное решение по спорной аренде.",
    scenarios: [
      {
        scenarioId: "deposit-dispute",
        description:
          "Собрать в одном представлении материалы сторон, сумму залога и историю. Дать записать решение и его основание.",
      },
    ],
  },
  {
    featureId: "collections",
    applicationId: "web",
    description: "Помочь начать выбор с задачи пользователя: похода, ремонта или праздника.",
    scenarios: [
      {
        scenarioId: "collections-browse",
        description:
          "Показать подборку с актуальными вещами, пояснением темы и переходами к карточкам.",
      },
    ],
  },
  {
    featureId: "collections",
    applicationId: "admin",
    description: "Дать команде управлять темами и составом подборок.",
    scenarios: [
      {
        scenarioId: "collections-manage",
        description:
          "Реализовать создание подборки, выбор вещей, порядок отображения и публикацию после предпросмотра.",
      },
    ],
  },
];

/** Заполненный пример с независимыми состояниями реализации в каждом приложении. */
export const CONTRIBUTION_SEEDS: ProductContribution[] = CONTRIBUTION_DETAILS.map((entry) => {
  const status =
    CONTRIBUTION_FEATURE_STATUS_SEEDS[`${entry.applicationId}/${entry.featureId}`] ?? "none";
  const sourceScenarios = Object.values(FEATURE_SCENARIO_SEEDS).flat();
  const scenarios = entry.scenarios.map((scenario) => {
    const source = sourceScenarios.find((item) => item.id === scenario.scenarioId);
    return {
      id: scenario.scenarioId,
      name: source?.name ?? scenario.scenarioId,
      goal: source?.description.split("\n\n")[0] ?? scenario.description,
      intent: scenario.description,
    };
  });
  return {
    ...entry,
    title: getContributionTitle(entry.description),
    description: buildContributionDescription({
      applicationId: entry.applicationId,
      intent: entry.description,
      scenarios,
    }),
    status,
    scenarios: entry.scenarios.map((scenario) => ({
      ...scenario,
      title: getContributionTitle(scenario.description),
      description: buildContributionDescription({
        applicationId: entry.applicationId,
        intent:
          scenarios.find((source) => source.id === scenario.scenarioId)?.goal ??
          scenario.description,
        scenarios: scenarios.filter((source) => source.id === scenario.scenarioId),
      }),
      status:
        CONTRIBUTION_SCENARIO_STATUS_SEEDS[`${entry.applicationId}/${scenario.scenarioId}`] ??
        status,
    })),
  };
});
