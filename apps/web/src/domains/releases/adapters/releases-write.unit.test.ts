/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import type { BatchResult, ReleaseRecord } from "@relay/contracts";
import { batchResponse, withAdapterHttp } from "domains/relay-data/testing/adapter-http";
import { ReleaseError, saveRelease } from "./releases.adapter";
import type { Release } from "../types/release.type";

const newRelease: Release = {
  id: "new",
  key: "",
  revision: 0,
  title: "Выпуск",
  version: "2.0",
  summary: "Кратко",
  description: "Точный Markdown\n\n**Итог**",
  planIds: ["plan-b", "plan-a"],
  status: "released",
  plannedFor: "2026-10-26",
  releasedAt: null,
  releasedBy: null,
  updatedAt: "",
  readiness: { total: 2, ready: 2, missing: 0, percent: 100, canRelease: true },
};
const published: ReleaseRecord = {
  id: "release-created",
  kind: "release",
  key: "REL-1",
  revision: 2,
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
  createdBy: "Автор сервера",
  updatedBy: "Автор сервера",
  data: {
    projectId: "release-create",
    title: "Выпуск",
    version: "2.0",
    summary: "Кратко",
    description: "Точный Markdown\n\n**Итог**",
    planIds: ["plan-b", "plan-a"],
    plannedFor: "2026-10-26",
    status: "released",
    releasedAt: "2026-10-26T00:00:00.000Z",
    releasedBy: "Автор сервера",
  },
};

describe("Пакеты адаптера релиза", () => {
  test("создание и публикация отправляются одним batch с локальными $ref и $revision", async () => {
    const receipt: Omit<BatchResult, "operationKey"> = {
      status: "committed",
      replayed: false,
      items: [
        {
          index: 0,
          op: "release.create",
          as: "release",
          id: "release-created",
          kind: "release",
          key: "REL-1",
          revision: 1,
          owner: { id: "release-created", kind: "release", key: "REL-1", revision: 1 },
          outputs: [],
        },
        {
          index: 1,
          op: "release.publish",
          as: null,
          id: "release-created",
          kind: "release",
          key: "REL-1",
          revision: 2,
          owner: { id: "release-created", kind: "release", key: "REL-1", revision: 2 },
          outputs: [],
        },
      ],
      entities: [structuredClone(published)],
    };

    const result = await withAdapterHttp(
      (request) => batchResponse(request, receipt),
      () => saveRelease("release-create", structuredClone(newRelease)),
    );

    expect(result.value).toEqual({ id: "release-created", key: "REL-1", revision: 2 });
    expect(result.requests.map((request) => request.method)).toEqual(["GET", "POST"]);
    expect(await result.requests[1]?.json()).toEqual({
      actor: "Автор сервера",
      operationKey: expect.any(String),
      commands: [
        {
          op: "release.create",
          as: "release",
          input: {
            title: "Выпуск",
            version: "2.0",
            summary: "Кратко",
            description: "Точный Markdown\n\n**Итог**",
            planIds: ["plan-b", "plan-a"],
            plannedFor: "2026-10-26",
          },
        },
        { op: "release.publish", ref: { $ref: "release" }, ifRevision: { $revision: "release" } },
      ],
    });
  });

  test("отказ исходного CAS редактирования сохраняет код и не отправляет отдельную публикацию", async () => {
    const existing = {
      ...structuredClone(newRelease),
      id: "release-existing",
      key: "REL-2",
      revision: 17,
    };

    const result = await withAdapterHttp(
      () =>
        Response.json(
          { ok: false, error: { code: "REVISION_CONFLICT", message: "Исходный релиз изменён" } },
          { status: 409 },
        ),
      () => saveRelease("release-conflict", existing).catch((error: unknown) => error),
    );

    expect(result.value).toBeInstanceOf(ReleaseError);
    expect(result.value).toMatchObject({
      code: "REVISION_CONFLICT",
      cause: { code: "REVISION_CONFLICT", status: 409 },
    });
    expect(result.requests).toHaveLength(2);
    expect(await result.requests[1]?.json()).toEqual({
      actor: "Автор сервера",
      operationKey: expect.any(String),
      commands: [
        {
          op: "release.update",
          as: "release",
          ref: "release-existing",
          ifRevision: 17,
          input: {
            title: "Выпуск",
            version: "2.0",
            summary: "Кратко",
            description: "Точный Markdown\n\n**Итог**",
            planIds: ["plan-b", "plan-a"],
            plannedFor: "2026-10-26",
          },
        },
        { op: "release.publish", ref: { $ref: "release" }, ifRevision: { $revision: "release" } },
      ],
    });
  });
});
