import { runGuardianEntry } from "@relay/project-runtime";
import { probeDefaultSsh } from "../transport/ssh-profile";

// Source-host приватных ролей. Compiled CLI подключает те же роли в собственном main.
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--guarded-command") {
  process.exitCode = await runGuardianEntry();
} else if (args[0] === "--ssh-profile" && args.length <= 2) {
  process.stdout.write(`${JSON.stringify(await probeDefaultSsh(args[1]))}\n`);
} else {
  process.exitCode = 2;
}
