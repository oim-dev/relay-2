import { describe, expect, test } from "bun:test";
import type { ServerContext } from "@relay/contracts";
import { mapWorkspace, resolveWorkspaceProject } from "./workspace-mapper";

const context: ServerContext = {
  version: "test",
  mode: "workspace",
  actor: "Автор",
  projects: [
    { id: "id-1", name: "main", slug: "commerce", available: true },
    { id: "id-1", name: "mirror", slug: "commerce", available: true },
    { id: "id-2", name: "secondary", slug: "same", available: true },
    { id: "id-3", name: "id-1", slug: "same", available: true },
    {
      id: null,
      name: "missing",
      slug: null,
      available: false,
      error: { code: "NOT_FOUND", message: "Нет проекта" },
    },
  ],
};

describe("Адреса проектов workspace", () => {
  test.each(["main", "mirror", "commerce", "id-1"])(
    "адрес %s разрешается в один постоянный ID",
    (reference) => {
      const workspace = mapWorkspace(context);

      expect(resolveWorkspaceProject(workspace, reference)?.id).toBe("id-1");
    },
  );

  test("одинаковый slug разных проектов не выбирает первый по порядку", () => {
    const workspace = mapWorkspace(context);

    expect(resolveWorkspaceProject(workspace, "same")).toBeUndefined();
    expect(resolveWorkspaceProject(workspace, "unknown")).toBeUndefined();
  });

  test("недоступная регистрация остаётся отдельным пунктом с причиной", () => {
    const workspace = mapWorkspace(context);

    expect(resolveWorkspaceProject(workspace, "missing")).toMatchObject({
      available: false,
      name: "missing",
      error: "Нет проекта (NOT_FOUND)",
    });
  });
});
