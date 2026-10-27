import { describe, expect, test } from "bun:test";
import type { ProductCommand, ProductState } from "../types/product.type";
import { productCommands } from "./product-commands";

const source: ProductState = {
  productId: "project",
  version: "28",
  records: [
    {
      id: "app",
      revision: 7,
      createdAt: "2026-10-26T00:00:00Z",
      updatedAt: "2026-10-26T00:00:00Z",
      fields: {
        kind: "application",
        name: "Web",
        summary: "",
        description: "",
        slug: "web",
        prefix: "WEB",
        type: "frontend",
      },
    },
    {
      id: "scope:app",
      revision: 7,
      createdAt: "2026-10-26T00:00:00Z",
      updatedAt: "2026-10-26T00:00:00Z",
      fields: {
        kind: "scope",
        applicationId: "app",
        contracts: [
          {
            id: "fi",
            revision: 11,
            featureId: "feature",
            scenarioId: null,
            title: "Реализация",
            description: "Прежнее",
            status: "done",
            active: false,
          },
        ],
      },
    },
  ],
};

describe("Команды продуктового редактора", () => {
  test("восстанавливает FI до новой SI, сохраняя отдельные CAS содержания и состава", () => {
    const command: ProductCommand = {
      action: "update",
      requestId: "scope",
      fields: {
        kind: "scope",
        applicationId: "app",
        contracts: [
          {
            featureId: "feature",
            scenarioId: null,
            title: "Новое название",
            description: "Новый текст",
            status: "done",
          },
          {
            featureId: "feature",
            scenarioId: "scenario",
            title: "Новая SI",
            description: "Текст SI",
            status: "partial",
          },
        ],
      },
    };

    const commands = productCommands(command, source);

    expect(commands).toEqual([
      {
        op: "implementation.update",
        ref: "fi",
        ifRevision: 11,
        input: { title: "Новое название", description: "Новый текст", status: "done" },
      },
      {
        op: "application.participation.replace",
        as: "restore",
        ref: "app",
        ifRevision: 7,
        input: { targets: ["feature"] },
      },
      {
        op: "implementation.create",
        as: "implementation2",
        ifRevision: { $revision: "restore" },
        input: {
          application: "app",
          target: "scenario",
          title: "Новая SI",
          description: "Текст SI",
          status: "partial",
        },
      },
      {
        op: "application.participation.replace",
        ref: "app",
        ifRevision: { $revision: "implementation2" },
        input: { targets: ["feature", "scenario"] },
      },
    ]);
  });

  test("редактирование приложения не отправляет неизменяемые slug и prefix", () => {
    const commands = productCommands(
      {
        action: "update",
        id: "app",
        ifRevision: 7,
        requestId: "edit",
        fields: {
          kind: "application",
          name: "Новое имя",
          summary: "Кратко",
          description: "Текст",
          slug: "web",
          prefix: "WEB",
          type: "backend",
        },
      },
      source,
    );

    expect(commands).toEqual([
      {
        op: "application.update",
        ref: "app",
        ifRevision: 7,
        input: { name: "Новое имя", summary: "Кратко", description: "Текст", type: "backend" },
      },
    ]);
  });
});
