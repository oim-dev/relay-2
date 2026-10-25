import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseInvocation } from "./arguments";
import type { ServerEnvironment } from "./process.types";

const environment: ServerEnvironment = {
  cwd: resolve("/isolated/workspace"),
  userHome: "relative-user-home",
  executablePath: "relay-server",
  standalone: true,
  env: {
    RELAY_CONFIG: "env.workspace.json",
    RELAY_HOME: "env-home",
    RELAY_ACTOR: "Автор среды",
    RELAY_WEB_ORIGIN: "http://localhost:5173",
  },
};

describe("Самостоятельный Server argv", () => {
  test("явные config/home/project/actor/port0 сохраняются дословно и имеют приоритет среды", () => {
    const input = parseInvocation(
      [
        "run",
        "--config",
        "explicit.workspace.json",
        "--home",
        "explicit-home",
        "--project",
        "Регистрация",
        "--actor",
        "Точный Автор",
        "--port",
        "0",
        "--allow-origin",
        "http://127.0.0.1:5173",
      ],
      environment,
    );

    expect(input).toEqual({
      kind: "direct",
      runtime: {
        cwd: environment.cwd,
        config: "explicit.workspace.json",
        home: "explicit-home",
        project: "Регистрация",
      },
      input: { actor: "Точный Автор", port: 0 },
      allowedOrigins: ["http://127.0.0.1:5173"],
    });
  });

  test("default home разрешается относительно переданного cwd, а dev port по умолчанию 3210", () => {
    const input = parseInvocation([], { ...environment, env: {} });

    expect(input).toEqual({
      kind: "direct",
      runtime: {
        cwd: environment.cwd,
        home: resolve(environment.cwd, environment.userHome, ".relay"),
      },
      input: { port: 3210 },
      allowedOrigins: [],
    });
  });

  test("launch сохраняет отдельный stdin lease и разрешённый origin без переопределения области", () => {
    expect(
      parseInvocation(["run", "--launch", "launch.json", "--parent-lease"], environment),
    ).toEqual({
      kind: "launch",
      path: resolve(environment.cwd, "launch.json"),
      parentLease: true,
      allowedOrigins: ["http://localhost:5173"],
    });
  });

  test.each(
    [
      ["--parent-lease"],
      ["--launch", "launch.json", "--port", "1"],
      ["--port", "65536"],
      ["--port", "1.5"],
      ["--allow-origin", "http://localhost:5173/path"],
      ["--unknown"],
      ["unexpected"],
    ].map((argv) => ({ argv })),
  )("неверная форма $argv отвергается до I/O", ({ argv }) => {
    expect(() => parseInvocation(argv, environment)).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT", exitCode: 2 }),
    );
  });

  test("help/version автономны даже при неизвестном аргументе и отсутствующем config", () => {
    expect(parseInvocation(["--config", "missing", "--unknown", "--version"], environment)).toEqual(
      { kind: "version" },
    );
    expect(parseInvocation(["--launch", "missing", "-h"], environment)).toEqual({ kind: "help" });
  });
});
