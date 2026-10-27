import { dlopen, FFIType, ptr } from "bun:ffi";
import { toNamespacedPath } from "node:path";
import { localFileMessages } from "../../local-files/replace.messages";

/* FILE_RENAME_INFO для поддерживаемого Win64 ABI: Flags, padding, HANDLE, DWORD, WCHAR[]. */
const renameNameOffset = 20;
/* FileRenameInfoEx из FILE_INFO_BY_HANDLE_CLASS. */
const renameInformationClass = 22;
/* FILE_RENAME_REPLACE_IF_EXISTS | FILE_RENAME_POSIX_SEMANTICS. */
const replaceWithOpenReaders = 0x00000003;
/* DELETE; доступ требуется только к собственному временному файлу. */
const deleteAccess = 0x00010000;
/* FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE. */
const shareAll = 0x00000007;

/**
 * Заменяет локальный файл одним Windows rename с сохранением открытых читателей прежнего файла.
 * Вызывается только на Windows после отказа обычного rename; source — закрытый соседний temp,
 * оба пути абсолютные, mutex read-modify-write принадлежит вызывающему. FILE_SHARE_DELETE
 * у читателей обязателен. Неподдерживаемая ФС, чужой запрещающий handle и ACL дают отказ
 * без unlink назначения, изменения его содержимого или повторов по таймеру.
 */
export function replaceWithWindowsOpenReaders(source: string, destination: string): void {
  const api = dlopen("kernel32.dll", {
    CreateFileW: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
      ],
      returns: FFIType.u64,
    },
    SetFileInformationByHandle: {
      args: [FFIType.u64, FFIType.u32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  /**
   * Сохраняет исходный Win32-код и оба пути без предметного преобразования ошибки.
   */
  function nativeFailure(syscall: string): Error {
    const win32Code = api.symbols.GetLastError();
    return Object.assign(
      new Error(localFileMessages.windowsReplacementFailed(syscall, win32Code)),
      {
        syscall,
        win32Code,
        path: source,
        dest: destination,
      },
    );
  }
  try {
    const sourceName = Buffer.from(`${toNamespacedPath(source)}\0`, "utf16le");
    // OPEN_EXISTING; FILE_FLAG_OPEN_REPARSE_POINT запрещает следовать подмене temp ссылкой.
    const handle = api.symbols.CreateFileW(
      ptr(sourceName),
      deleteAccess,
      shareAll,
      null,
      3,
      0x00200000,
      null,
    );
    if (BigInt(handle) === 0xffffffffffffffffn) {
      throw nativeFailure("CreateFileW");
    }
    try {
      const targetName = Buffer.from(`${toNamespacedPath(destination)}\0`, "utf16le");
      const information = Buffer.alloc(renameNameOffset + targetName.length);
      information.writeUInt32LE(replaceWithOpenReaders, 0);
      // RootDirectory остаётся NULL; FileNameLength не включает завершающий WCHAR NUL.
      information.writeUInt32LE(targetName.length - 2, 16);
      targetName.copy(information, renameNameOffset);
      if (
        !api.symbols.SetFileInformationByHandle(
          handle,
          renameInformationClass,
          ptr(information),
          information.length,
        )
      ) {
        throw nativeFailure("SetFileInformationByHandle");
      }
    } finally {
      api.symbols.CloseHandle(handle);
    }
  } finally {
    api.close();
  }
}
