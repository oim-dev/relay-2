import { runGuardianEntry } from "./entry";

// Доверенный служебный вход исходного Bun-пакета; не использует проверяемый executable как helper.
if (process.argv.length === 3 && process.argv[2] === "--guarded-command") {
  process.exitCode = await runGuardianEntry();
} else {
  process.exitCode = 1;
}
