import type { GitPlatform } from "./git-platform.types";
import { quoteGitShellWord, sshRemoteSyntax } from "./ssh-syntax";

/**
 * macOS Git использует sh и /dev/null; native Keychain и пользовательский SSH config сохраняются.
 */
export const macosGitPlatform: GitPlatform = {
  disabledHooksPath: "/dev/null",
  usesSsh: sshRemoteSyntax,
  shellWord: quoteGitShellWord,
};
