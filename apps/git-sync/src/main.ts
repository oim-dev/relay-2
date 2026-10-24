import { failure } from "./app/errors";
import { runGuardianEntry } from "@relay/project-runtime";
import { probeDefaultSsh } from "./transport/ssh-profile";
import { version } from "../package.json";

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--guarded-command") {
    process.exitCode = await runGuardianEntry();
  } else if (args.length === 1 && args[0] === "--ssh-profile") {
    process.stdout.write(JSON.stringify(await probeDefaultSsh()) + "\n");
  } else if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(`${version}\n`);
  } else {
    const { runProcessEntry } = await import("./app/process-run");
    process.exitCode = await runProcessEntry(args);
  }
} catch (error) {
  const response = failure(error);
  process.stderr.write(`${response.error.code}: ${response.error.message}\n`);
  process.exitCode = response.error.exitCode;
}
