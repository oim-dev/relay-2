import { describe, expect, test } from "bun:test";
import { librarySectionCommands } from "./library-section-commands";

describe("Команды разделов библиотеки", () => {
  test("пустой no-op всё равно передаёт исходный CAS проекта", () => {
    const commands = librarySectionCommands(
      { ref: "project", projectName: "Проект", revision: 12, sections: [] },
      [],
    );

    expect(commands).toEqual([
      { op: "project.update", as: "section0", ifRevision: 12, input: { name: "Проект" } },
    ]);
  });

  test("снятие, создание и порядок используют цепочку ревизий одного владельца", () => {
    const commands = librarySectionCommands(
      {
        ref: "project",
        projectName: "Проект",
        revision: 12,
        sections: [{ id: "old", name: "Старый" }],
      },
      [{ id: "new", name: "Новый" }],
    );

    expect(commands).toEqual([
      { op: "project.update", as: "section0", ifRevision: 12, input: { name: "Проект" } },
      {
        op: "document.section.remove",
        as: "section1",
        ifRevision: { $revision: "section0" },
        input: { id: "old" },
      },
      {
        op: "document.section.create",
        as: "section2",
        ifRevision: { $revision: "section1" },
        input: { id: "new", name: "Новый" },
      },
      {
        op: "document.section.move",
        as: "section3",
        ifRevision: { $revision: "section2" },
        input: { id: "new", last: true },
      },
    ]);
  });
});
