import { nativeFileReplacement } from "../native/file-replacement/select";

/**
 * Синхронно публикует подготовленный локальный файл атомарной заменой имени назначения.
 * Вызывающий владеет закрытым регулярным temporaryPath в том же физическом каталоге,
 * что targetPath, и заранее выбрал/проверил namespace назначения. Оба пути абсолютные.
 * Подготовка содержимого, fsync и политика symlink принадлежат вызывающему.
 * Успех потребляет имя temp; открытые читатели сохраняют прежние байты назначения,
 * новые открытия видят подготовленный файл. На Windows читатели разрешают FILE_SHARE_DELETE.
 * При отказе temp остаётся у вызывающего для уборки, назначение не удаляется и не перезаписывается.
 * Mutex не берётся: весь read-modify-write обязан защищать внешний владелец сценария.
 * Ошибки ФС передаются без предметного преобразования; native-отказ сохраняет syscall,
 * win32Code, path и dest. После Windows EPERM обычного rename используется одна
 * POSIX-совместимая native-операция, без unlink назначения и повторов по времени.
 */
export function replaceLocalFile(temporaryPath: string, targetPath: string): void {
  nativeFileReplacement()(temporaryPath, targetPath);
}
