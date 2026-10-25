import type { ApplicationData, FeatureData, ImplementationData } from "@relay/contracts";
import type { CatalogKind, KnowledgeSnapshot } from "./knowledge.types";

/**
 * Содержимое описаний знаний без служебного состояния формы.
 */
export interface KnowledgeContentMap {
  /* Заполняемые поля паспорта продукта. */
  readonly product: Readonly<Pick<FeatureData, "name" | "summary" | "description">>;
  /* Описание функциональности. */
  readonly feature: KnowledgeContentMap["product"];
  /* Описание сценария; родитель изменением текста не переносится. */
  readonly scenario: KnowledgeContentMap["product"];
  /* Содержание приложения без неизменяемых адресов. */
  readonly application: Readonly<
    Pick<ApplicationData, "name" | "summary" | "description" | "type">
  >;
  /* Сохранённый вклад и его степень реализации; active принадлежит участию. */
  readonly implementation: Readonly<Pick<ImplementationData, "title" | "description" | "status">>;
}

/**
 * Изменение существующей карточки с исходным чтением её владельца.
 */
export type KnowledgeUpdate = {
  [K in CatalogKind]: {
    /* Намерение изменения существующего знания. */
    readonly action: "update";
    /* Вид определяет разрешённое содержание. */
    readonly kind: K;
    /* Первоначальная карточка и её guards. */
    readonly source: KnowledgeSnapshot;
    /* Поля только выбранного вида знания. */
    readonly content: KnowledgeContentMap[K];
  };
}[CatalogKind];

/**
 * Создание нового знания; владельцы связей и CAS передаются явно.
 */
export type KnowledgeCreate =
  | {
      /* Создание фичи без существующего владельца CAS. */
      readonly action: "create";
      /* Вид создаваемого знания. */
      readonly kind: "feature";
      /* Тексты новой фичи. */
      readonly content: KnowledgeContentMap["feature"];
    }
  | {
      /* Создание сценария с неизменяемым родителем. */
      readonly action: "create";
      /* Вид создаваемого знания. */
      readonly kind: "scenario";
      /* Тексты нового сценария. */
      readonly content: KnowledgeContentMap["scenario"];
      /* Постоянный ID родительской фичи. */
      readonly featureId: string;
    }
  | {
      /* Создание приложения вместе с его доской. */
      readonly action: "create";
      /* Вид создаваемого знания. */
      readonly kind: "application";
      /* Описание и назначение приложения. */
      readonly content: KnowledgeContentMap["application"];
      /* Канонический адрес нового приложения. */
      readonly slug: string;
      /* Префикс ключей; отсутствие оставляет значение по умолчанию Core. */
      readonly prefix?: string;
    }
  | {
      /* Создание реализации изменяет состав приложения. */
      readonly action: "create";
      /* Вид создаваемого знания. */
      readonly kind: "implementation";
      /* Содержание вклада. */
      readonly content: KnowledgeContentMap["implementation"];
      /* Исходная карточка приложения-владельца состава. */
      readonly application: KnowledgeSnapshot;
      /* Постоянный ID цели-фичи либо сценария. */
      readonly targetId: string;
    };

/**
 * Готовое предметное намерение редактора; не содержит пустых ссылок и полей UI.
 */
export type KnowledgeWrite = KnowledgeCreate | KnowledgeUpdate;
