export interface CliRuntime {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  stdin: string | (() => string | Promise<string>);
}

export function processRuntime(): CliRuntime {
  return {
    cwd: process.cwd(),
    env: process.env,
    stdin: () => Bun.stdin.text(),
  };
}
