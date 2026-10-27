import { currentNativePlatform } from "@relay/project-runtime";
import { linuxDirectoryLink } from "./linux/directory-link";
import { macosDirectoryLink } from "./macos/directory-link";
import { windowsDirectoryLink } from "./windows/directory-link";

/**
 * Подготавливает native-алиас чужого каталога; assertions владения остаются у сценария.
 */
export function createDirectoryLink(target: string, link: string): void {
  switch (currentNativePlatform()) {
    case "linux":
      return linuxDirectoryLink(target, link);
    case "darwin":
      return macosDirectoryLink(target, link);
    case "win32":
      return windowsDirectoryLink(target, link);
  }
}
