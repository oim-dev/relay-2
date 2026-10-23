import type { KnowledgeKind } from "@relay/contracts";
import type { CommandHelp } from "../../output/help.types";

const examples = {
  project: "",
  product: "",
  feature: " FEATURE-1",
  scenario: " SCENARIO-1",
  application: " APP-1",
  implementation: " WEB-FI-1",
  document: " DOC-1",
  board: " BOARD-PRODUCT",
} as const;

const readDetails = {
  project:
    "Паспорт проекта создаётся через init. Его ревизия защищает также разделы документов: document section list/create/update/move/remove. Выбор конфигурации объясняет config get.",
  product:
    "Единственный паспорт продукта содержит назначение, аудиторию, границы и ожидаемый результат. При его отсутствии используйте product create. Требования описываются через feature и scenario.",
  feature:
    "Фича описывает продуктовую возможность, её правила и границы. Сценарии читаются через scenario list --feature <ссылка>, реализации фичи вместе со сценарными — implementation list --feature <ссылка>.",
  scenario:
    "Сценарий содержит условия, шаги, альтернативы, ошибки и результат пользовательского пути. Связанная фича читается через feature get; реализации — implementation list --target <ссылка>.",
  application:
    "Приложение имеет собственную доску и состав участия в требованиях. Реализации читаются через application participation list, задачи — task list --board <slug приложения>.",
  implementation:
    "Реализация связывает приложение с фичей или сценарием. Сохранённая отметка status не является вычисленной готовностью задач. Снятое участие сохраняет историю; состав меняется через application participation replace.",
  document:
    "body содержит полный Markdown, summary — отдельную аннотацию. Прикрепления читаются через document links, разделы библиотеки — document section list. Полное тело не заменяется кратким списком.",
  board:
    "Доска продукта создаётся при init, доска приложения — при application create. Содержание доски не включает автоматическое чтение задач: используйте task list --board <ключ, slug или ID>.",
} as const;

const listFilters: Partial<Record<KnowledgeKind, Pick<CommandHelp, "details" | "examples">>> = {
  application: {
    details: "--type выбирает приложения указанного типа; без него доступны все типы.",
    examples: [
      {
        description: "Прочитать серверные приложения",
        command: "relay application list --type backend --limit 20",
      },
    ],
  },
  board: {
    details: "--application принимает ссылку на приложение и выбирает его доску.",
    examples: [
      {
        description: "Найти доску приложения",
        command: "relay board list --application APP-1",
      },
    ],
  },
  document: {
    details:
      "--without-section выбирает документы без раздела, включая документы из удалённых разделов. Флаг несовместим с --section-id; --without-section=false отключает его. --section-id всегда принимает буквальный ID: none не означает отсутствие раздела.",
    examples: [
      {
        description: "Найти документы без раздела",
        command: "relay document list --without-section --limit 20",
      },
    ],
  },
  implementation: {
    details:
      "--feature выбирает реализации фичи вместе с реализациями её сценариев. --target ограничивает точную цель: фичу либо один сценарий. Условия --feature, --target, --application, --active и --status пересекаются; несовпадающие условия дают пустую страницу.",
    examples: [
      {
        description: "Прочитать реализации всей фичи в приложении",
        command: "relay implementation list --feature FEATURE-1 --application APP-1 --limit 20",
      },
    ],
  },
};

/**
 * Русские тексты команд знаний, документов и участия приложений.
 */
export const knowledgeCommandMessages = {
  groups: {
    project: {
      description: "Паспорт проекта",
      details: readDetails.project,
      examples: [{ description: "Прочитать паспорт и ревизию", command: "relay project get" }],
    },
    product: {
      description: "Паспорт продукта",
      details: readDetails.product,
      examples: [{ description: "Прочитать назначение продукта", command: "relay product get" }],
    },
    feature: {
      description: "Фичи продукта",
      details: readDetails.feature,
      examples: [{ description: "Найти продуктовые возможности", command: "relay feature list" }],
    },
    scenario: {
      description: "Пользовательские сценарии",
      details: readDetails.scenario,
      examples: [
        {
          description: "Прочитать сценарии фичи",
          command: "relay scenario list --feature FEATURE-1",
        },
      ],
    },
    application: {
      description: "Приложения продукта",
      details: readDetails.application,
      examples: [{ description: "Прочитать список приложений", command: "relay application list" }],
    },
    implementation: {
      description: "Реализации требований в приложениях",
      details: readDetails.implementation,
      examples: [
        {
          description: "Прочитать активные реализации приложения",
          command: "relay implementation list --application APP-1 --active",
        },
      ],
    },
    document: {
      description: "Документы и библиотека знаний",
      details: readDetails.document,
      examples: [{ description: "Найти документы", command: "relay document list" }],
    },
    board: {
      description: "Доски задач",
      details: readDetails.board,
      examples: [{ description: "Прочитать доступные доски", command: "relay board list" }],
    },
  },
  /**
   * Описывает адресное чтение с навигацией соответствующего вида знаний.
   */
  get: (kind: KnowledgeKind): CommandHelp => ({
    description: "Прочитать полное содержание и ревизию",
    details: `${readDetails[kind]}\n\nВозвращает полную запись. Перед изменением передайте прочитанную revision в --if-revision. Ключи, прежние ключи и постоянные ID разрешаются в выбранном проекте; project get и product get выбирают единственный паспорт без аргумента.`,
    examples: [
      {
        description: "Прочитать запись перед изменением",
        command: `relay ${kind} get${examples[kind]}`,
      },
    ],
  }),
  /**
   * Объясняет общий контракт страниц, сохраняя предметное назначение каталога.
   */
  list: (kind: KnowledgeKind): CommandHelp => {
    const filters = listFilters[kind];
    return {
      description: "Прочитать страницу кратких записей",
      details: [
        readDetails[kind],
        ...(filters ? [filters.details] : []),
        "--q ищет по ключу, ID и предметным текстам. --sort key и title сортируют по возрастанию, updated — последние изменения первыми. Фильтры применяются до пагинации. Для полного содержания используйте get, для следующей страницы — nextCommand; после изменения данных начните список заново.",
      ].join("\n\n"),
      examples: [
        { description: "Прочитать первую страницу", command: `relay ${kind} list --limit 20` },
        ...(filters?.examples ?? []),
      ],
    };
  },
  create: {
    product: {
      description: "Создать паспорт продукта",
      details:
        "Создаёт единственный паспорт в выбранном проекте; повторное создание отклоняется. Требуется непустое name. summary — краткая аннотация, description — полное назначение, аудитория, границы и результат в Markdown. Автор задаётся через --actor или RELAY_ACTOR. Для правки существующего паспорта используйте product get и product update.",
      examples: [
        {
          description: "Описать продукт",
          command:
            "relay product create --name 'Каталог товаров' --description '## Назначение\nПомочь покупателю найти подходящий товар.\n\n## Аудитория\nПокупатели интернет-магазина.\n\n## Границы\nПоиск и сравнение товаров; оплата описывается отдельно.' --actor human",
        },
      ],
    },
    feature: {
      description: "Создать фичу продукта",
      details:
        "Требуется непустое name. summary — краткая аннотация, description — полное описание возможности: цель, правила, границы и ожидаемый результат в Markdown. Это содержание требования, а не краткая аннотация. Сценарии конкретных путей создаются через scenario create --feature <ключ новой фичи>.",
      examples: [
        {
          description: "Описать продуктовую возможность",
          command:
            "relay feature create --name 'Поиск товаров' --description '## Цель\nНайти товары по запросу покупателя.\n\n## Правила\nПоказывать подходящие товары; при пустом ответе объяснять отсутствие совпадений.\n\n## Границы\nРанжирование и фильтры описываются отдельными требованиями.' --actor human",
        },
      ],
    },
    scenario: {
      description: "Создать сценарий фичи",
      details:
        "Обязательны name и feature — ключ или ID существующей фичи. description раскрывает предусловия, шаги, альтернативы, ошибки и результат в Markdown. Это полное описание, а не краткая аннотация. Фича закрепляется при создании; scenario update меняет только тексты. В JSON вместо feature допустим featureId, одновременно оба поля передавать нельзя.",
      examples: [
        {
          description: "Описать путь восстановления после ошибки",
          command:
            "relay scenario create --feature FEATURE-1 --name 'Повтор поиска после отказа' --description '## Условия\nПользователь ввёл запрос.\n\n## Шаги\nОтправить запрос; при отказе показать сообщение и кнопку повтора.\n\n## Ошибки и результат\nСохранить исходный ввод. Повторный запрос использует тот же текст.' --actor human",
        },
      ],
    },
    application: {
      description: "Создать приложение с собственной доской",
      details:
        "Обязательны name и slug. prefix по умолчанию — slug в верхнем регистре, type — frontend. Префикс начинается с заглавной латинской буквы и содержит не более 32 символов. Для slug с цифровым началом или длиной больше 32 символов задайте prefix явно, например --slug 2fa --prefix MFA. Создание приложения и его доски атомарно. slug и prefix закрепляются при создании.\n\ndescription описывает назначение, ответственность, интерфейсы и границы приложения. Участие в фичах и сценариях задаётся через implementation create или application participation replace.",
      examples: [
        {
          description: "Создать веб-приложение и доску WEB",
          command:
            "relay application create --name 'Витрина' --slug web --prefix WEB --type frontend --description 'Веб-интерфейс каталога и поиска товаров.' --actor human",
        },
        {
          description: "Создать приложение с цифровым началом slug",
          command:
            "relay application create --name 'Двухфакторная аутентификация' --slug 2fa --prefix MFA --type backend --actor human",
        },
      ],
    },
    implementation: {
      description: "Создать реализацию требования в приложении",
      details:
        "Обязательны title, application и target — фича или сценарий. Для реализации сценария сначала включите его фичу в участие приложения. Пара приложение/цель уникальна; ранее снятое участие возвращается через application participation replace.\n\ndescription описывает работу и ограничения по вкладу именно этого приложения, а не краткую аннотацию общего требования. По умолчанию status=none. Создание обновляет состав и ревизию приложения; собственное содержание реализации меняется под её ревизией.",
      examples: [
        {
          description: "Описать вклад приложения в фичу",
          command:
            "relay implementation create --application APP-1 --target FEATURE-1 --title 'Форма поиска в витрине' --description '## Ответственность\nПринять запрос покупателя и показать результат API.\n\n## Ошибки\nСохранить запрос и дать повтор при отказе.\n\n## Проверка\nПроверить успех, пустой результат и сетевую ошибку.' --actor human",
        },
      ],
    },
    document: {
      description: "Создать документ с полным Markdown",
      details:
        "Обязательны name и непустое body. Передайте текст через --body, UTF-8 файл через --body-file или весь JSON-объект через --input/--input-file. summary — отдельная краткая аннотация. По умолчанию documentKind=description, documentStatus=draft, pinned=false, раздел не выбран.\n\n--targets прикрепляет документ к целям с типом documents; --relations принимает массив {target, type?, description?}. Эти способы несовместимы. Для раздела используйте ID из document section list. Создание документа и всех прикреплений атомарно.",
      examples: [
        {
          description: "Создать документ из подготовленного файла",
          command:
            "relay document create --name 'Правила проверки' --body-file ./rules.md --actor human",
        },
        {
          description: "Сохранить небольшой документ напрямую",
          command:
            "relay document create --name 'Ревью' --body '## Правило\n\nВсе изменения проходят ревью.' --actor human",
        },
      ],
    },
  },
  update: {
    project: {
      description: "Изменить имя или slug проекта",
      details:
        "Передайте хотя бы name или slug и revision из project get. Неуказанные поля сохраняются. Постоянный ID, расположение базы и имя регистрации workspace не меняются. Для читаемого ключа используйте project rename.",
      examples: [
        {
          description: "Переименовать проект",
          command: "relay project update --name 'Каталог товаров' --if-revision 1 --actor human",
        },
      ],
    },
    product: {
      description: "Изменить содержание паспорта продукта",
      details:
        "Передайте хотя бы name, summary или description и revision из product get. Неуказанные поля сохраняются. description содержит полное назначение продукта, аудиторию, границы и результат; summary — отдельную аннотацию.",
      examples: [
        {
          description: "Уточнить назначение из файла",
          command:
            "relay product update --description-file ./product.md --if-revision 1 --actor human",
        },
      ],
    },
    feature: {
      description: "Изменить содержание фичи",
      details:
        "Передайте хотя бы name, summary или description и revision из feature get. Неуказанные поля сохраняются. Полный Markdown description раскрывает цель, правила, границы и ожидаемый результат, а не краткую аннотацию. Сценарии редактируются отдельно.",
      examples: [
        {
          description: "Уточнить требования из файла",
          command:
            "relay feature update FEATURE-1 --description-file ./feature.md --if-revision 1 --actor human",
        },
      ],
    },
    scenario: {
      description: "Изменить содержание сценария",
      details:
        "Передайте хотя бы name, summary или description и revision из scenario get. Неуказанные поля сохраняются; фича закреплена при создании. Полный Markdown description раскрывает шаги, альтернативы, ошибки и результат, а не краткую аннотацию.",
      examples: [
        {
          description: "Уточнить пользовательский путь",
          command:
            "relay scenario update SCENARIO-1 --description-file ./scenario.md --if-revision 1 --actor human",
        },
      ],
    },
    application: {
      description: "Изменить содержание приложения",
      details:
        "Меняет только переданные name, summary, description и type под ревизией приложения. Изменение name атомарно синхронизирует имя связанной доски и повышает также её ревизию; ключ доски сохраняется. Ревизию доски Core проверяет внутри операции. slug и prefix закреплены при создании. description раскрывает ответственность и границы приложения. Участие в требованиях меняется через application participation replace.",
      examples: [
        {
          description: "Уточнить ответственность приложения",
          command:
            "relay application update APP-1 --description-file ./application.md --if-revision 2 --actor human",
        },
      ],
    },
    implementation: {
      description: "Изменить содержание реализации",
      details:
        "Передайте хотя бы title, description или status и собственную revision реализации из implementation get. Приложение и цель закреплены при создании. description — полный Markdown по вкладу именно этого приложения, а не краткая аннотация. status — сохранённая отметка, не результат внешних проверок.",
      examples: [
        {
          description: "Уточнить содержание реализации",
          command:
            "relay implementation update WEB-FI-1 --description-file ./implementation.md --if-revision 1 --actor human",
        },
      ],
    },
    document: {
      description: "Изменить переданные поля документа",
      details:
        "Передайте хотя бы одно поле и revision из document get. Неуказанные поля сохраняются, body остаётся непустым Markdown. --targets или --relations заменяют весь набор прикреплений; одновременно их передавать нельзя. Для добавления одной связи используйте document link.\n\n--input '{\"targets\":[]}' очищает прикрепления; --input '{\"sectionId\":null}' снимает раздел. --pinned=false снимает закрепление. Весь JSON-ввод несовместим с отдельными предметными полями.",
      examples: [
        {
          description: "Обновить полное тело документа",
          command:
            "relay document update DOC-1 --body-file ./rules.md --if-revision 1 --actor human",
        },
        {
          description: "Снять раздел и закрепление",
          command:
            'relay document update DOC-1 --input \'{"sectionId":null,"pinned":false}\' --if-revision 1 --actor human',
        },
      ],
    },
  },
  /**
   * Показывает изменение адреса с правильным числом позиционных аргументов паспорта или записи.
   */
  rename: (kind: KnowledgeKind): CommandHelp => ({
    description: "Изменить читаемый ключ, сохранив ID и алиасы",
    details:
      "Меняется ключ записи, а не её название, slug или префикс доски. Постоянный ID и структурированные связи сохраняются, прежний ключ остаётся алиасом. Коллизия адреса и устаревшая ревизия отклоняются. Ревизию получите через get этого вида; у единственных project и product передаётся только новый ключ.",
    examples: [
      {
        description: "Назначить новый читаемый адрес",
        command: `relay ${kind} rename${examples[kind]} CUSTOM-1 --if-revision 1 --actor human`,
      },
    ],
  }),
  section: {
    description: "Разделы библиотеки документов",
    details:
      "Разделы принадлежат проекту. Их создание, переименование, порядок и удаление защищаются revision из project get или document section list. Документы назначаются в раздел через document create/update --section-id.",
    examples: [
      { description: "Прочитать порядок разделов", command: "relay document section list" },
    ],
  },
  sectionList: {
    description: "Прочитать разделы в заданном порядке",
    details:
      "Возвращает страницу разделов с ID и ревизией проекта-владельца. Эту revision передавайте в --if-revision команд разделов. Документы выбранного раздела читаются через document list --section-id <ID>.",
    examples: [
      {
        description: "Получить ID разделов и ревизию проекта",
        command: "relay document section list --limit 20",
      },
    ],
  },
  sectionActions: {
    create: {
      description: "Создать раздел библиотеки",
      details:
        "Задайте новый ID позиционным аргументом и непустое name через --name или --input. Раздел добавляется в конец. Требуется revision проекта. Ранее удалённые ID зарезервированы и повторно не используются.",
      examples: [
        {
          description: "Добавить раздел требований",
          command:
            "relay document section create requirements --name 'Требования' --if-revision 1 --actor human",
        },
      ],
    },
    update: {
      description: "Переименовать раздел библиотеки",
      details:
        "Аргумент — ID из document section list. Меняет только name, ID и документы сохраняются. --if-revision принадлежит проекту, а не документу.",
      examples: [
        {
          description: "Уточнить название раздела",
          command:
            "relay document section update requirements --name 'Требования продукта' --if-revision 2 --actor human",
        },
      ],
    },
    move: {
      description: "Переместить раздел библиотеки",
      details:
        "Передайте ID перемещаемого раздела и ровно один способ позиции: --before <ID другого раздела> либо --last. Ревизия принадлежит проекту. Порядок проверяется через document section list.",
      examples: [
        {
          description: "Поставить раздел в конец",
          command: "relay document section move requirements --last --if-revision 3 --actor human",
        },
      ],
    },
    remove: {
      description: "Удалить раздел, сохранив документы",
      details:
        "Аргумент — ID раздела, --if-revision — ревизия проекта. Документы сохраняются и отображаются без удалённого раздела; их собственные ревизии не меняются. ID раздела остаётся зарезервированным.",
      examples: [
        {
          description: "Убрать раздел библиотеки",
          command: "relay document section remove requirements --if-revision 4 --actor human",
        },
      ],
    },
  },
  unlink: {
    description: "Снять прикрепление документа",
    details:
      "Передайте документ, обязательный --target и тип --relation (по умолчанию documents). Снимается выбранная пара цель/тип; документ и цель сохраняются. Ревизия принадлежит документу. Доступные прикрепления показывает document links.",
    examples: [
      {
        description: "Снять прикрепление к фиче",
        command: "relay document unlink DOC-1 --target FEATURE-1 --if-revision 2 --actor human",
      },
    ],
  },
  link: {
    description: "Прикрепить документ к сущности",
    details:
      "Передайте документ, обязательный --target и тип --relation (по умолчанию documents). --description поясняет отношение. Для существующей пары цель/тип переданное описание обновляется; остальные связи сохраняются. --if-revision принадлежит документу.",
    examples: [
      {
        description: "Прикрепить документ с пояснением",
        command:
          "relay document link DOC-1 --target FEATURE-1 --description 'Правила приёмки поиска.' --if-revision 1 --actor human",
      },
    ],
  },
  links: {
    description: "Прочитать прикрепления документа",
    details:
      "Возвращает страницу связей с типом, целью, пояснением и ревизией документа. Тело документа читается через document get. Одну связь меняют link/unlink, весь набор — document update --targets или --relations.",
    examples: [
      { description: "Проверить прикрепления", command: "relay document links DOC-1 --limit 20" },
    ],
  },
  participation: {
    description: "Участие приложения в требованиях",
    details:
      "Состав задаёт активные реализации фич и сценариев. Для сценария требуется участие в его фиче. list читает активный состав, replace заменяет его целиком под ревизией приложения. Снятые реализации сохраняют ID и содержание.",
    examples: [
      {
        description: "Прочитать активное участие",
        command: "relay application participation list APP-1",
      },
    ],
  },
  participationList: {
    description: "Прочитать активный состав участия приложения",
    details:
      "Возвращает страницу активных реализаций и ревизию приложения. Полный каталог, включая снятые реализации, доступен через implementation list --application <ссылка>. Для replace используйте ревизию приложения и полный желаемый набор целей.",
    examples: [
      {
        description: "Прочитать активные реализации",
        command: "relay application participation list APP-1 --limit 20",
      },
    ],
  },
  participationReplace: {
    description: "Заменить полный набор целей приложения",
    details:
      "--targets принимает фичи, сценарии или реализации этого приложения; повторяйте параметр. Для сценария включите также его фичу. Новые реализации создаются, прежние возвращаются, отсутствующие в новом составе снимаются с сохранением ID и содержания.\n\nРевизия принадлежит приложению. Пустой состав задаётся явно через --input '{\"targets\":[]}'. Пропуск targets не означает очистку. Набор изменяется атомарно.",
    examples: [
      {
        description: "Задать полный состав участия",
        command:
          "relay application participation replace APP-1 --targets FEATURE-1 --targets SCENARIO-1 --if-revision 2 --actor human",
      },
      {
        description: "Явно снять всё участие",
        command:
          "relay application participation replace APP-1 --input '{\"targets\":[]}' --if-revision 2 --actor human",
      },
    ],
  },
  fields: {
    name: "Непустое однострочное название записи обычным текстом",
    projectName: "Человекочитаемое однострочное имя проекта обычным текстом",
    summary: "Краткая текстовая аннотация для списков; не заменяет полное содержание",
    productDescription: "Полный Markdown паспорта: назначение, аудитория, границы и результат",
    featureDescription: "Полный Markdown фичи: цель, правила, границы и ожидаемый результат",
    scenarioDescription:
      "Полный Markdown сценария: условия, шаги, альтернативы, ошибки и результат",
    applicationDescription:
      "Полный Markdown приложения: назначение, ответственность, интерфейсы и границы",
    implementationDescription:
      "Полный Markdown реализации: вклад именно этого приложения, решения и проверки",
    documentBody: "Полное непустое содержание документа в Markdown",
    relationDescription: "Пояснение прикрепления документа к выбранной цели в Markdown",
    sectionName: "Непустое однострочное название раздела библиотеки обычным текстом",
    projectSlug: "Slug проекта",
    feature: "Ключ или ID фичи; обязателен при создании сценария",
    applicationSlug: "Slug приложения",
    boardPrefix:
      "Префикс доски: от 1 до 32 символов, начинается с A–Z; далее A–Z, цифры и одиночные дефисы между ними; по умолчанию slug в верхнем регистре",
    applicationType: "Тип приложения; при создании по умолчанию frontend",
    applicationTypeFilter: "Только приложения указанного типа",
    title: "Непустой однострочный заголовок реализации обычным текстом",
    application: "Ссылка на приложение: ключ, ID, алиас, slug или prefix",
    applicationFilter: "Ссылка на приложение: ключ, ID, алиас, slug или prefix",
    implementationFeatureFilter: "Ссылка на фичу; включает реализации самой фичи и её сценариев",
    implementationTargetFilter: "Ссылка на точную цель: фичу или сценарий",
    requirementTarget: "Фича или сценарий",
    implementationStatus:
      "Сохранённая степень реализации требования, а не вычисляемая готовность задач",
    documentKind: "Вид документа",
    documentStatus: "Состояние документа",
    sectionId: "ID раздела",
    pinned: "Признак закрепления документа; false снимает закрепление",
    documentTarget: "Ссылка на цель прикрепления документа",
    documentRelations:
      "Полный JSON-массив {target, type?, description?}: target — строковая ссылка или {kind, id}, type — тип связи, description — пояснение отношения в Markdown; несовместим с targets",
    sort: "key/title — по возрастанию, updated — последние изменения первыми",
    query: "Поиск по содержанию",
    status: "Состояние",
    target: "Цель",
    active: "Только активные реализации",
    section: "Буквальный ID раздела; несовместим с --without-section",
    withoutSection: "Документы без раздела; несовместим с --section-id; false отключает фильтр",
    pinnedFilter: "Закреплённые документы",
    key: "Новый читаемый ключ",
    beforeSection: "Поместить перед разделом",
    lastSection: "Поместить в конец",
    relationTarget: "Цель связи",
    relationType: "Тип связи",
  },
  unknownSort: "Неизвестный порядок списка",
  conflictingSectionFilters: "Параметры --without-section и --section-id несовместимы",
  sectionDestinationRequired: "Укажите ровно один параметр: --before или --last",
  participationTargetsRequired: "Укажите targets как массив ссылок",
} as const;
