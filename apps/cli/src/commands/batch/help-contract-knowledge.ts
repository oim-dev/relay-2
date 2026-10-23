import type {
  ApplicationData,
  DocumentData,
  ImplementationData,
  KnowledgeKind,
} from "@relay/contracts";
import { batchContractMessages as messages } from "../../locales/commands/batch-contract";
import {
  aliasField,
  defaultField,
  defineContract,
  nullableField,
  optionalField,
  requiredField,
  updateField,
} from "./help-contract-fields";
import type { BatchFieldContract, BatchHelpContractFactory } from "./help-contract.types";

const rules = messages.rules;
const example = messages.examples;
const applicationType: ApplicationData["type"] = "frontend";
const implementationStatus: ImplementationData["status"] = "none";
const documentKind: DocumentData["documentKind"] = "description";
const documentStatus: DocumentData["documentStatus"] = "draft";
const relationType = "documents" satisfies DocumentData["relations"][number]["type"];
const references: Readonly<Record<KnowledgeKind, string>> = {
  project: "PROJECT",
  product: "PRODUCT",
  feature: "FEATURE-1",
  scenario: "SCENARIO-1",
  application: "APP-1",
  implementation: "WEB-FI-1",
  document: "DOC-1",
  board: "BOARD-PRODUCT",
};

/**
 * Создаёт общие политики нового знания только внутри фабрики выбранного листа.
 */
function namedCreation(): Readonly<Record<string, BatchFieldContract>> {
  return { name: requiredField(), summary: defaultField(""), description: defaultField("") };
}

/**
 * Создаёт политики частичного изменения текстов только для выбранной операции.
 */
function namedUpdate(): Readonly<Record<string, BatchFieldContract>> {
  return { name: updateField(), summary: updateField(), description: updateField() };
}

/**
 * Описывает два альтернативных способа задать прикрепления, сохраняя различие create/update.
 */
function documentLinks(creation: boolean): Readonly<Record<string, BatchFieldContract>> {
  const omission = creation ? messages.documentCreateLinks : messages.documentUpdateLinks;
  return {
    targets: { presence: messages.optionalAlternative("relations"), omission, nullable: false },
    relations: { presence: messages.optionalAlternative("targets"), omission, nullable: false },
  };
}

/**
 * Регистрирует фабрики знаний и вложенных действий без создания политик и примеров.
 * Каждый callback готовит только собственный лист по правилам предметного владельца.
 */
export function knowledgeHelpContractFactories(): ReadonlyMap<string, BatchHelpContractFactory> {
  const factories = new Map<string, BatchHelpContractFactory>([
    [
      "project.update",
      () =>
        defineContract(
          "project.update",
          { name: updateField(), slug: updateField() },
          [rules.knowledgeUpdate, rules.projectUpdate],
          { name: example.productName },
        ),
    ],
    [
      "product.create",
      () =>
        defineContract("product.create", namedCreation(), [rules.productCreate, rules.text], {
          name: example.productName,
          summary: example.productSummary,
          description: example.productBody,
        }),
    ],
    [
      "product.update",
      () =>
        defineContract(
          "product.update",
          namedUpdate(),
          [rules.knowledgeUpdate, rules.productUpdate, rules.text],
          { description: example.productBody },
        ),
    ],
    [
      "feature.create",
      () =>
        defineContract("feature.create", namedCreation(), [rules.newKnowledge, rules.text], {
          name: example.featureName,
          description: example.featureBody,
        }),
    ],
    [
      "feature.update",
      () =>
        defineContract(
          "feature.update",
          namedUpdate(),
          [rules.knowledgeUpdate, rules.text],
          { description: example.featureBody },
          { ref: references.feature },
        ),
    ],
    [
      "scenario.create",
      () =>
        defineContract(
          "scenario.create",
          {
            ...namedCreation(),
            feature: aliasField("featureId"),
            featureId: aliasField("feature"),
          },
          [rules.newKnowledge, rules.scenario, rules.text],
          {
            name: example.scenarioName,
            feature: references.feature,
            description: example.scenarioBody,
          },
        ),
    ],
    [
      "scenario.update",
      () =>
        defineContract(
          "scenario.update",
          namedUpdate(),
          [rules.knowledgeUpdate, rules.text],
          { description: example.scenarioBody },
          { ref: references.scenario },
        ),
    ],
    [
      "application.create",
      () =>
        defineContract(
          "application.create",
          {
            ...namedCreation(),
            slug: requiredField(),
            prefix: optionalField(messages.prefixFromSlug),
            type: defaultField(applicationType),
          },
          [rules.newKnowledge, rules.application, rules.text],
          {
            name: example.applicationName,
            slug: "web",
            prefix: "WEB",
            type: applicationType,
            description: example.applicationBody,
          },
        ),
    ],
    [
      "application.update",
      () =>
        defineContract(
          "application.update",
          { ...namedUpdate(), type: updateField() },
          [rules.knowledgeUpdate, rules.applicationUpdate, rules.text],
          { description: example.applicationBody },
          { ref: references.application },
        ),
    ],
    [
      "implementation.create",
      () =>
        defineContract(
          "implementation.create",
          {
            title: requiredField(),
            description: defaultField(""),
            status: defaultField(implementationStatus),
            application: aliasField("applicationId"),
            applicationId: aliasField("application"),
            target: requiredField(),
          },
          [rules.implementation, rules.implementationTarget, rules.text],
          {
            title: example.implementationTitle,
            application: references.application,
            target: references.feature,
            status: implementationStatus,
            description: example.implementationBody,
          },
        ),
    ],
    [
      "implementation.update",
      () =>
        defineContract(
          "implementation.update",
          { title: updateField(), description: updateField(), status: updateField() },
          [rules.knowledgeUpdate, rules.implementationUpdate, rules.text],
          { description: example.implementationBody },
          { ref: references.implementation },
        ),
    ],
    ...documentHelpContractFactories(),
  ]);
  for (const kind of [
    "project",
    "product",
    "feature",
    "scenario",
    "application",
    "implementation",
    "document",
    "board",
  ] as const) {
    factories.set(`${kind}.rename`, () =>
      defineContract(
        `${kind}.rename`,
        { key: requiredField() },
        [rules.rename],
        { key: `CUSTOM-${kind.toUpperCase()}` },
        kind === "project" || kind === "product" ? {} : { ref: references[kind] },
      ),
    );
  }
  factories.set("application.participation.replace", () =>
    defineContract(
      "application.participation.replace",
      { targets: requiredField() },
      [rules.participation, rules.participationHistory],
      { targets: [references.feature, references.scenario] },
      { ref: references.application },
    ),
  );
  return new Map([...factories, ...sectionHelpContractFactories()]);
}

/**
 * Регистрирует ленивые фабрики документов; даже вложенный пример связи создаётся по запросу.
 */
function documentHelpContractFactories(): ReadonlyMap<string, BatchHelpContractFactory> {
  return new Map([
    [
      "document.create",
      () =>
        defineContract(
          "document.create",
          {
            name: requiredField(),
            body: requiredField(),
            summary: defaultField(""),
            documentKind: defaultField(documentKind),
            documentStatus: defaultField(documentStatus),
            pinned: defaultField(false),
            sectionId: nullableField(optionalField(messages.noSection), messages.noSection),
            ...documentLinks(true),
          },
          [rules.newKnowledge, rules.document, rules.documentLists, rules.text],
          {
            name: example.documentName,
            body: example.documentBody,
            documentKind,
            documentStatus,
            sectionId: null,
            relations: [
              {
                target: { kind: "feature", id: references.feature },
                type: relationType,
                description: example.relationBody,
              },
            ],
          },
        ),
    ],
    [
      "document.update",
      () =>
        defineContract(
          "document.update",
          {
            name: updateField(),
            body: updateField(),
            summary: updateField(),
            documentKind: updateField(),
            documentStatus: updateField(),
            pinned: updateField(),
            sectionId: nullableField(updateField(), messages.clearSection),
            ...documentLinks(false),
          },
          [rules.knowledgeUpdate, rules.document, rules.documentLists, rules.text],
          { body: example.documentBody, sectionId: null },
          { ref: references.document },
        ),
    ],
    [
      "document.link",
      () =>
        defineContract(
          "document.link",
          {
            target: requiredField(),
            type: defaultField(relationType),
            description: optionalField(messages.linkDescription),
          },
          [rules.documentLink, rules.text],
          { target: references.feature, type: relationType, description: example.relationBody },
          { ref: references.document },
        ),
    ],
    [
      "document.unlink",
      () =>
        defineContract(
          "document.unlink",
          { target: requiredField(), type: defaultField(relationType) },
          [rules.documentLink, rules.documentUnlink],
          { target: references.feature, type: relationType },
          { ref: references.document },
        ),
    ],
  ]);
}

/**
 * Регистрирует фабрики разделов без подготовки политик ID, позиции и владельца CAS.
 */
function sectionHelpContractFactories(): ReadonlyMap<string, BatchHelpContractFactory> {
  return new Map([
    [
      "document.section.create",
      () =>
        defineContract(
          "document.section.create",
          { id: optionalField(messages.generatedSectionId), name: requiredField() },
          [rules.section, rules.sectionCreate],
          { id: "requirements", name: example.sectionName },
        ),
    ],
    [
      "document.section.update",
      () =>
        defineContract(
          "document.section.update",
          { id: requiredField(), name: requiredField() },
          [rules.section, rules.sectionUpdate],
          { id: "requirements", name: example.sectionUpdatedName },
        ),
    ],
    [
      "document.section.move",
      () =>
        defineContract(
          "document.section.move",
          {
            id: requiredField(),
            before: nullableField(
              {
                presence: messages.beforeSection,
                omission: messages.omittedBeforeSection,
                nullable: false,
              },
              messages.atEnd,
            ),
            last: {
              presence: messages.lastSection,
              omission: messages.omittedLastSection,
              nullable: false,
            },
          },
          [rules.section, rules.sectionMove],
          { id: "requirements", before: null },
        ),
    ],
    [
      "document.section.remove",
      () =>
        defineContract(
          "document.section.remove",
          { id: requiredField() },
          [rules.section, rules.sectionRemove],
          { id: "requirements" },
        ),
    ],
  ]);
}
