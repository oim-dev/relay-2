import { restorationMessages } from "../../project/restoration.messages";

/**
 * Сохраняет native errno и оба имени отказавшего no-replace переноса.
 */
export function publicationMoveFailure(
  syscall: string,
  errno: number,
  source: string,
  destination: string,
): Error {
  return Object.assign(new Error(restorationMessages.moveFailed(syscall, errno)), {
    code: errno === 17 ? "EEXIST" : "IO_ERROR",
    errno,
    syscall,
    path: source,
    dest: destination,
  });
}
