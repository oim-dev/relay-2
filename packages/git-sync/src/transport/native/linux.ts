import type { GitPlatform } from "./git-platform.types";
import { quoteGitShellWord, sshRemoteSyntax } from "./ssh-syntax";

/**
 * Linux Git использует системный sh и POSIX null device; backslash в argv сохраняется.
 */
export const linuxGitPlatform: GitPlatform = {
  disabledHooksPath: "/dev/null",
  usesSsh: sshRemoteSyntax,
  shellWord: quoteGitShellWord,
};
