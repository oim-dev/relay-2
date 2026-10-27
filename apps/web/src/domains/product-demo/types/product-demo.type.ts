import type { z } from "zod";
import type { ProductDocumentationInput } from "./documentation.type";
import type { DocumentationScope } from "./documentation.type";
import type {
  DEMO_MODE_SCHEMA,
  PRODUCT_DOCUMENT_SCHEMA,
  PRODUCT_APPLICATION_SCHEMA,
  PRODUCT_CONTRIBUTION_SCHEMA,
  PRODUCT_FEATURE_SCHEMA,
  PRODUCT_SCENARIO_SCHEMA,
  PRODUCT_SNAPSHOT_SCHEMA,
  PRODUCT_STATUS_SCHEMA,
  PRODUCT_WORK_SCHEMA,
} from "../config/product-demo.schema";

/** Готовность фичи или сценария. */
export type ProductStatus = z.infer<typeof PRODUCT_STATUS_SCHEMA>;
/** Сценарий проверки интерфейса. */
export type DemoMode = z.infer<typeof DEMO_MODE_SCHEMA>;
/** Читаемый документ продукта. */
export type ProductDocument = z.infer<typeof PRODUCT_DOCUMENT_SCHEMA>;
/** Возможность продукта. */
export type ProductFeature = z.infer<typeof PRODUCT_FEATURE_SCHEMA>;
/** Подраздел фичи с проверяемым поведением и собственным состоянием. */
export type ProductScenario = z.infer<typeof PRODUCT_SCENARIO_SCHEMA>;
/** Логическое приложение продукта. */
export type ProductApplication = z.infer<typeof PRODUCT_APPLICATION_SCHEMA>;
/** Заявленный вклад приложения в фичу и её сценарии. */
export type ProductContribution = z.infer<typeof PRODUCT_CONTRIBUTION_SCHEMA>;
/** Вклад в одну фичу для операции настройки состава приложения. */
export type ProductContributionInput = Omit<ProductContribution, "applicationId">;
/** Связанная работа. */
export type ProductWork = z.infer<typeof PRODUCT_WORK_SCHEMA>;
/** Единые данные всех экранов. */
export type ProductSnapshot = z.infer<typeof PRODUCT_SNAPSHOT_SCHEMA>;
/** Раздел документа. */
export type ProductDocumentKind = "passport" | "features" | "applications" | "scenarios";
/** Данные операции редактирования. */
export type ProductDocumentInput = {
  /** Раздел. */
  kind: ProductDocumentKind;
  /** Пустое значение означает создание. */
  id: string;
  /** Родительская фича для операции над сценарием. */
  featureId: string;
  /** Название. */
  name: string;
  /** Краткое назначение. */
  summary: string;
  /** Полный Markdown. */
  description: string;
  /** Готовность сценария; для остальных документов не применяется. */
  status: ProductStatus;
  /** Назначение приложения. */
  type: string;
  /** Постоянный адрес приложения и доски; у других документов пустая строка. */
  slug: string;
  prefix: string;
};
/** Результат локального сохранения. */
export type ProductSaveResult =
  | { /** Успех. */ isSaved: true; /** Идентификатор документа. */ id: string }
  | { /** Отказ с сохранением ввода. */ isSaved: false; /** Объяснение. */ message: string };
/** Контракт области продуктового прототипа. */
export type ProductDemoContextValue = {
  /** Фиксирует основание открытого редактора; SSE не заменяет его. */
  captureRevision: (revision: number, draftScope: string) => void;
  /** Освобождает основание после успешной записи или явного удаления черновика. */
  releaseRevision: (draftScope: string) => void;
  /** Реальные цели связей текущего продукта. */
  scopes: DocumentationScope[];
  /** Актуальный снимок. */
  snapshot: ProductSnapshot;
  /** Сценарий интерфейса. */
  mode: DemoMode;
  /** Состояние локального хранения. */
  notice: string;
  /** Переключение сценария. */
  setMode: (mode: DemoMode) => void;
  /** Сохранение документа с сохранением состава приложений. */
  saveDocument: (input: ProductDocumentInput, revision: number) => Promise<ProductSaveResult>;
  /** Локальное сохранение Markdown-материала с визуальными примерами областей. */
  saveDocumentation: (
    input: ProductDocumentationInput,
    revision: number,
  ) => Promise<ProductSaveResult>;
  /** Атомарное сохранение выбранных фич, сценариев и описаний их вкладов. */
  saveApplicationScope: (
    applicationId: string,
    contributions: ProductContributionInput[],
    revision: number,
  ) => Promise<ProductSaveResult>;
  /** Возврат исходных данных. */
  reset: () => void;
};
