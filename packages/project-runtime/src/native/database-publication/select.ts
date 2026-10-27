import { currentNativePlatform } from "../platform";
import type { NativePlatform } from "../platform.types";
import { linuxDatabasePublication } from "./linux";
import { macosDatabasePublication } from "./macos";
import { windowsDatabasePublication } from "./windows";
import type { DatabasePublication } from "./publication.types";

const implementations: Readonly<Record<NativePlatform, DatabasePublication>> = {
  linux: linuxDatabasePublication,
  darwin: macosDatabasePublication,
  win32: windowsDatabasePublication,
};

/**
 * Выбирает протокол публикации хоста без открытия SQLite или native-библиотек.
 */
export function nativeDatabasePublication(): DatabasePublication {
  return implementations[currentNativePlatform()];
}
