import { readFileSync } from "node:fs";
import { registerProject, unregisterProject } from "../../src";

const input = JSON.parse(process.argv[2]!) as {
  cwd: string;
  home: string;
  config: string;
  target: string;
  prefix: string;
  count: number;
  action: "register" | "unregister" | "read";
};

let index = 0;
let stopped = false;
process.on("message", (message) => {
  if (message === "stop") {
    stopped = true;
    process.disconnect?.();
    return;
  }
  if (message !== "go") return;
  if (input.action === "read") {
    const read = () => {
      if (stopped) return;
      const config = JSON.parse(readFileSync(input.config, "utf8"));
      if (config.version !== 1 || !Array.isArray(config.projects)) {
        throw new Error("Читатель получил неполную конфигурацию workspace");
      }
      setImmediate(read);
    };
    read();
    return;
  }

  const name = `${input.prefix}-${index}`;
  if (input.action === "register") registerProject(input, name, input.target);
  else unregisterProject(input, name);
  index++;
  if (index === input.count) process.disconnect?.();
  else process.send?.({ ready: index });
});
process.send?.({ ready: index });
