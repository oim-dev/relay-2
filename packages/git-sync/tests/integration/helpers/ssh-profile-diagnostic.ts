import { redact, runProcess } from "../../../src/transport/process";
import { probeSsh } from "../../../src/transport/ssh-profile";

// Этот вход запускается Git alias только после отказа integration assert.
// Используется production probe с тем же Git PATH и общим Runtime guardian.
// Полный -G stdout, окружение и пользовательские настройки в журнал не попадают.
const probe = await probeSsh(
  { executable: Bun.which("ssh"), cwd: process.cwd() },
  async (input) => {
    const result = await runProcess(input);
    process.stdout.write(
      JSON.stringify({
        executable: input.executable,
        args: input.args,
        exitCode: result.exitCode,
        stderr: redact(result.stderr.subarray(-1024).toString("utf8")),
        ...(input.args[0] === "-V"
          ? { stdout: redact(result.stdout.subarray(-1024).toString("utf8")) }
          : {}),
      }) + "\n",
    );
    return result;
  },
);
process.stdout.write(JSON.stringify({ platform: process.platform, probe }) + "\n");
