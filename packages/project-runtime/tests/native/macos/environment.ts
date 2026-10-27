import { realpathSync } from "node:fs";
import { userInfo } from "node:os";
import type { NativeCommands } from "../native-command";
import type { NativeSession } from "../native-service.types";

/**
 * Проверяет существующий launchd gui-домен пользователя, не создавая login-сессию.
 */
export async function preflightMacosSession(commands: NativeCommands): Promise<NativeSession> {
  const userHome = realpathSync(userInfo().homedir);
  const uid = process.getuid?.();
  if (uid === undefined || uid === 0) {
    throw new Error(
      "NATIVE_SERVICE_SESSION_REQUIRED: нужен непривилегированный POSIX-пользователь",
    );
  }
  if (realpathSync(commands.env.HOME ?? userHome) !== userHome) {
    throw new Error(
      "NATIVE_SERVICE_SESSION_REQUIRED: HOME должен принадлежать текущему пользователю",
    );
  }
  await commands.run("launchctl", ["print", `gui/${uid}`]);
  return { userHome, uid, linger: null };
}
