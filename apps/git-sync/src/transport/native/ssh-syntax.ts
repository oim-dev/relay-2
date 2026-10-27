/**
 * Распознаёт переносимую SSH URL/scp форму после исключения локального синтаксиса ОС.
 */
export function sshRemoteSyntax(remote: string): boolean {
  if (/^ssh:\/\//i.test(remote)) {
    return true;
  }
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(remote) && /^[^/\\:]+(?:@[^/\\:]+)?:[^/\\]/.test(remote);
}

/**
 * Экранирует одно слово POSIX sh, в том числе sh поставки Git for Windows.
 */
export function quoteGitShellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
