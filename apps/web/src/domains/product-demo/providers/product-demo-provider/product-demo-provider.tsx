import { useRef } from "react";
import { productError, saveProduct, useProduct, PRODUCT_LINK_SCHEMA } from "domains/product";
import type { ProductCommand, ProductInput, ProductLink, ProductState } from "domains/product";
import { createProductView } from "../../helpers/create-product-view";
import { productDraftSources } from "../../stores/product-draft-sources";
import { ProductDemoContext } from "./product-demo-context";
import type { ProductDocumentationInput } from "../../types/documentation.type";
import type {
  DemoMode,
  ProductDocumentInput,
  ProductContributionInput,
  ProductSaveResult,
} from "../../types/product-demo.type";
import type { ProductDemoProviderProps } from "./types/product-demo-provider-props.type";

/** Типы приложений постоянного контракта. */
const APPLICATION_TYPES = {
  Фронтенд: "frontend",
  Бэкенд: "backend",
  "Внутренний инструмент": "internal",
} as const;

/**
 * Подключает постоянный продукт к существующим экранам.
 *
 * Используется для:
 *  - проекции общих серверных данных и реальных связей
 *  - сохранения редакторов с исходной версией без автоматического повтора
 */
export const ProductDemoProvider = (props: ProductDemoProviderProps) => {
  const { scopeId, children } = props;
  const query = useProduct(scopeId);
  const requestsRef = useRef(new Map<string, string>());
  const sourcesRef = useRef(productDraftSources(scopeId));
  const state = query.data;
  const view = createProductView(state ?? { productId: scopeId, version: "0", records: [] });
  const mode: DemoMode = state === undefined ? (query.error ? "read-error" : "loading") : "filled";

  /**
   * Удерживает только снимки реально открытых редакторов, а не каждое SSE-поколение.
   * Неизвестный старый черновик не получает свежий guard вместо исходного.
   */
  const captureRevision = (revision: number, draftScope: string): void => {
    if (
      state !== undefined &&
      revision === view.snapshot.revision &&
      sourcesRef.current.get(draftScope)?.version !== String(revision)
    ) {
      sourcesRef.current.set(draftScope, state);
    }
  };

  /**
   * Освобождает только завершённый черновик, не основания других редакторов.
   */
  const releaseRevision = (draftScope: string): void => {
    sourcesRef.current.delete(draftScope);
  };

  /**
   * Находит удержанное основание формы без замены исходных CAS новым чтением.
   */
  const sourceForRevision = (revision: number): ProductState | undefined =>
    [...sourcesRef.current.values()].find((source) => source.version === String(revision)) ??
    (revision === view.snapshot.revision ? state : undefined);

  /**
   * Проверяет версию формы до отправки и сохраняет requestId при сетевом отказе.
   */
  const persist = async (
    fields: ProductInput,
    id: string,
    revision: number,
  ): Promise<ProductSaveResult> => {
    const source = sourceForRevision(revision);
    if (source === undefined)
      return {
        isSaved: false,
        message: "Продукт изменился после чтения. Сохраните ввод и загрузите актуальную версию.",
      };
    const previous = source.records.find((record) => record.id === id);
    if (id !== "" && previous === undefined)
      return { isSaved: false, message: "Редактируемая запись больше не существует." };
    const operation = {
      action: previous === undefined ? ("create" as const) : ("update" as const),
      ...(previous === undefined ? {} : { id: previous.id, ifRevision: previous.revision }),
      fields,
    };
    const fingerprint = JSON.stringify(operation);
    const requestId = requestsRef.current.get(fingerprint) ?? crypto.randomUUID();
    requestsRef.current.set(fingerprint, requestId);
    const command: ProductCommand = { ...operation, requestId };
    try {
      const saved = await saveProduct(scopeId, command, source);
      await query.mutate().catch(() => undefined);
      requestsRef.current.delete(fingerprint);
      return { isSaved: true, id: saved.id };
    } catch (error) {
      return { isSaved: false, message: productError(error) };
    }
  };

  /**
   * Сохраняет содержание без ручного статуса общего сценария.
   */
  const saveDocument = async (
    input: ProductDocumentInput,
    revision: number,
  ): Promise<ProductSaveResult> => {
    const common = { name: input.name, summary: input.summary, description: input.description };
    if (input.kind === "passport")
      return persist({ kind: "passport", ...common }, input.id, revision);
    if (input.kind === "features")
      return persist({ kind: "feature", ...common }, input.id, revision);
    if (input.kind === "scenarios")
      return persist(
        {
          kind: "scenario",
          featureId: input.featureId,
          name: input.name,
          description: input.description,
        },
        input.id,
        revision,
      );
    const type =
      Object.entries(APPLICATION_TYPES).find(([label]) => label === input.type)?.[1] ?? "frontend";
    return persist(
      {
        kind: "application",
        ...common,
        type,
        slug: input.slug,
        ...(input.prefix ? { prefix: input.prefix } : {}),
      },
      input.id,
      revision,
    );
  };

  /**
   * Сохраняет документ и независимые типизированные ссылки одной операцией.
   */
  const saveDocumentation = async (
    input: ProductDocumentationInput,
    revision: number,
  ): Promise<ProductSaveResult> => {
    let links: ProductLink[];
    try {
      links = input.scopeIds.map((id) => PRODUCT_LINK_SCHEMA.parse(JSON.parse(id)));
    } catch {
      return {
        isSaved: false,
        message: "Связи черновика устарели. Выберите области из текущего продукта.",
      };
    }
    return persist(
      {
        kind: "document",
        name: input.name,
        summary: input.summary,
        body: input.body,
        documentKind: input.kind,
        links,
      },
      input.id,
      revision,
    );
  };

  /**
   * Атомарно заменяет состав одного приложения; ядро сохраняет идентичность контрактов.
   */
  const saveApplicationScope = async (
    applicationId: string,
    contributions: ProductContributionInput[],
    revision: number,
  ): Promise<ProductSaveResult> => {
    const scope = sourceForRevision(revision)?.records.find(
      (record) => record.fields.kind === "scope" && record.fields.applicationId === applicationId,
    );
    const contracts = contributions.flatMap((entry) => [
      {
        featureId: entry.featureId,
        scenarioId: null,
        title: entry.title,
        description: entry.description,
        status: entry.status,
      },
      ...entry.scenarios.map((scenario) => ({
        featureId: entry.featureId,
        scenarioId: scenario.scenarioId,
        title: scenario.title,
        description: scenario.description,
        status: scenario.status,
      })),
    ]);
    return persist({ kind: "scope", applicationId, contracts }, scope?.id ?? "", revision);
  };

  /**
   * Повторяет реальное чтение после отказа.
   */
  const retry = (): void => {
    void query.mutate();
  };

  return (
    <ProductDemoContext
      value={{
        snapshot: view.snapshot,
        scopes: view.scopes,
        mode,
        notice: query.error && state !== undefined ? productError(query.error) : "",
        setMode: retry,
        reset: retry,
        saveDocument,
        saveDocumentation,
        saveApplicationScope,
        captureRevision,
        releaseRevision,
      }}
    >
      {children}
    </ProductDemoContext>
  );
};
