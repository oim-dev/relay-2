import { runGuardianEntry } from "@relay/project-runtime";

if (process.argv[2] === "--guarded-command") {
  process.exit(await runGuardianEntry());
}
const { runServerProcess } = await import("./process/run");
process.exit(await runServerProcess(process.argv.slice(2)));
