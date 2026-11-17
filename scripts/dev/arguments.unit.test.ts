import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseDevelopmentArguments } from "./arguments";

const cwd = resolve("/checkout/relay-2");
const invalidOptions = [
  { name: "пустой playground", args: ["--playground", ""] },
  { name: "пустой home", args: ["--home", " "] },
  { name: "динамический порт", args: ["--port", "0"] },
  { name: "дробный порт", args: ["--web-port", "1.5"] },
  { name: "слишком большой порт", args: ["--port", "65536"] },
  { name: "одинаковые порты", args: ["--port", "5174"] },
];

describe("Выбор внешнего dev-playground", () => {
  test("стандартная раскладка использует соседний playground и общий home, не shell cwd пакета", () => {
    const input = parseDevelopmentArguments([], cwd, {});

    expect(input).toEqual({
      runtime: { cwd: resolve(cwd, "../playground"), home: resolve(cwd, "../.relay-home") },
      port: 3210,
      webPort: 5174,
    });
  });

  test("явные пути, автор и порты имеют приоритет над окружением", () => {
    const input = parseDevelopmentArguments(
      [
        "--",
        "--playground",
        "../other",
        "--home",
        "./data",
        "--actor",
        "Разработчик",
        "--port",
        "4100",
        "--web-port",
        "4101",
      ],
      cwd,
      { RELAY_HOME: "/unrelated", RELAY_CONFIG: "/unrelated/config", RELAY_ACTOR: "Другой" },
    );

    expect(input).toEqual({
      runtime: { cwd: resolve(cwd, "../other"), home: resolve(cwd, "data") },
      actor: "Разработчик",
      port: 4100,
      webPort: 4101,
    });
  });

  test("окружение direnv сохраняет явный home и точное авторство", () => {
    const input = parseDevelopmentArguments([], cwd, {
      RELAY_HOME: "../custom",
      RELAY_ACTOR: "Автор",
    });

    expect(input).toMatchObject({ runtime: { home: resolve(cwd, "../custom") }, actor: "Автор" });
  });

  test.each(invalidOptions)("$name отклоняется как неверный параметр dev", ({ args }) => {
    expect(() => parseDevelopmentArguments(args, cwd, {})).toThrow(
      "Некорректные параметры dev; используйте bun run dev -- --help",
    );
  });

  test("неизвестный флаг отклоняется парсером, а не теряется при передаче Bun", () => {
    expect(() => parseDevelopmentArguments(["--", "--unknown"], cwd, {})).toThrow(
      expect.objectContaining({ code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" }),
    );
  });

  test("справка не требует playground или корректного home", () => {
    const input = parseDevelopmentArguments(["--help"], cwd, { RELAY_HOME: "" });

    expect(input).toBeNull();
  });
});
