import { rm } from "node:fs/promises";

// Устаревшие compiled operations не должны переживать удаление endpoint из OpenAPI.
await rm(new URL("../dist/generated", import.meta.url), { recursive: true, force: true });
