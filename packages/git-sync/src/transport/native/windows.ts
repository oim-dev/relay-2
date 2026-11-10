import type { GitPlatform } from "./git-platform.types";
import { quoteGitShellWord, sshRemoteSyntax } from "./ssh-syntax";

/**
 * Git for Windows интерпретирует alias/sshCommand своим sh, включая поддержку /dev/null.
 * Native drive paths отличны от scp remote; контролируемые пути передаются sh со слешами.
 */
export const windowsGitPlatform: GitPlatform = {
  disabledHooksPath: "/dev/null",
  /**
   * Исключает Windows drive paths до разбора scp-синтаксиса.
   */
  usesSsh(remote): boolean {
    return !/^[a-z]:/i.test(remote) && sshRemoteSyntax(remote);
  },
  /**
   * Кодирует собственный аргумент для sh внутри Git for Windows.
   */
  shellWord(value): string {
    return quoteGitShellWord(value.replaceAll("\\", "/"));
  },
};
