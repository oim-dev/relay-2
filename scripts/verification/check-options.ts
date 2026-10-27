/**
 * Принимает только общий лимит параллельности: полный check нельзя сузить фильтром или списком задач.
 * По умолчанию четыре одновременные задачи Turbo; Bun workers внутри набора не включаются.
 */
export function checkConcurrency(args: readonly string[]): number {
  if (args.length === 0) {
    return 4;
  }
  let value: string | undefined;
  if (args.length === 1 && args[0]?.startsWith("--concurrency=")) {
    value = args[0].slice("--concurrency=".length);
  } else if (args.length === 2 && args[0] === "--concurrency") {
    value = args[1];
  }
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value) || Number(value) > 32) {
    throw new Error(verificationMessages.concurrency);
  }
  return Number(value);
}
import { verificationMessages } from "./verification.messages";
