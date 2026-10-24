import { runGuardianEntry } from "@relay/project-runtime";

// Изолированная сборка проверяет публичную private роль общего Runtime guardian.
process.exit(await runGuardianEntry());
