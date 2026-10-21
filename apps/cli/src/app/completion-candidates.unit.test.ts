import { describe, expect, test } from "bun:test";
import type { Args } from "gunshi";
import type { RegistryCommand } from "../execution/registry.types";
import { completionCandidates } from "./completion-candidates";

describe("Значения перечислений для completion", () => {
  test("вложенная команда получает собственные и глобальные enum из схем, строковые поля пропускаются", () => {
    const globals: Args = { format: { type: "enum", choices: ["text", "json"] } };
    const move: RegistryCommand = {
      name: "move",
      args: {
        column: { type: "enum", choices: ["todo", "done"] },
        ref: { type: "positional" },
      },
      subCommands: new Map(),
    };
    const commands = new Map<string, RegistryCommand>([
      ["task", { name: "task", subCommands: new Map([["move", move]]) }],
    ]);

    const config = completionCandidates(commands, globals);

    expect(config.entry?.args?.format?.handler({})).toEqual([{ value: "text" }, { value: "json" }]);
    expect(config.subCommands?.["task move"]?.args?.format?.handler({})).toEqual([
      { value: "text" },
      { value: "json" },
    ]);
    expect(config.subCommands?.["task move"]?.args?.column?.handler({})).toEqual([
      { value: "todo" },
      { value: "done" },
    ]);
    expect(config.subCommands?.["task move"]?.args?.ref).toBeUndefined();
  });

  test("собственный строковый аргумент перекрывает глобальный enum, скрытый enum не предлагает значений", () => {
    const globals: Args = { format: { type: "enum", choices: ["text", "json"] } };
    const commands = new Map<string, RegistryCommand>([
      [
        "custom",
        {
          name: "custom",
          args: {
            format: { type: "string" },
            secret: { type: "enum", choices: ["internal"], hidden: true },
          },
          subCommands: new Map(),
        },
      ],
    ]);

    const config = completionCandidates(commands, globals);

    expect(config.subCommands?.custom?.args).toEqual({});
  });
});
