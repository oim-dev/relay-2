import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { RuntimeOptions } from "./runtime-options.types";
import { validateOptions } from "./paths";

/**
 * Вычисляет абсолютный корень локального состояния без создания файлов и чтения RELAY_HOME.
 * Явный home разрешается от cwd; по умолчанию используется homedir()/.relay.
 * Некорректные параметры отклоняются до обращения к файловой системе; symlink пока сохраняется.
 */
export function resolveRelayHome(options: RuntimeOptions): string {
  validateOptions(options);
  return resolve(options.cwd, options.home ?? join(homedir(), ".relay"));
}
