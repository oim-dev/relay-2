import type { BuildArtifact } from "../verification/verification.types";

/**
 * Закреплённые версии инструментов, которыми произведён результат сборки.
 */
export interface ArtifactToolchain {
  /* Версия из .bun-version без префикса v. */
  readonly bun: string;
  /* Версия из .node-version без префикса v. */
  readonly node: string;
}

/**
 * Контекст одного checkout; передаётся явно, чтобы fixtures не меняли cwd и окружение.
 */
export interface ArtifactContext {
  /* Абсолютный корень checkout, в который разрешены публикации output. */
  readonly root: string;
  /* Полный SHA коммита, совпадающий с GITHUB_SHA производителя и потребителя. */
  readonly sha: string;
  /* Проверенные закреплённые версии инструментов. */
  readonly toolchain: ArtifactToolchain;
}

/**
 * Формат передачи CI v1; USTAR содержит только directory и его обычные файлы/каталоги.
 * Расширения и имена за пределами формата USTAR отклоняются producer, а не преобразуются молча.
 * Hash защищает целостность передачи, а доверие к производителю обеспечивает выбор CI run.
 */
export interface ArtifactManifest {
  /* Версия протокола передачи, не версия приложения. */
  readonly version: 1;
  /* ID BuildArtifact из общего каталога проверок. */
  readonly id: string;
  /* Компонент-производитель из того же каталога. */
  readonly component: string;
  /* portable либо точный ID нативного target. */
  readonly target: string;
  /* SHA исходников производителя. */
  readonly sha: string;
  /* Версия Bun производителя. */
  readonly bun: string;
  /* Версия Node.js производителя. */
  readonly node: string;
  /* Единственный разрешённый корень внутри payload.tar, относительно checkout. */
  readonly directory: string;
  /* SHA-256 байтов payload.tar, 64 строчных шестнадцатеричных символа. */
  readonly sha256: string;
}

/**
 * Заголовок поддержанного USTAR; расширения PAX/GNU и ссылки в протокол v1 не входят.
 */
export interface ArtifactTarEntry {
  /* UTF-8 имя относительно checkout, ещё не проверенное на принадлежность output. */
  readonly path: string;
  /* Сырой typeflag USTAR: 0/48 — файл, 53 — каталог; прочие значения запрещены. */
  readonly type: number;
  /* Размер тела файла в байтах; у каталога требуется ноль. */
  readonly size: number;
  /* POSIX permissions без специальных setuid/setgid/sticky-битов. */
  readonly mode: number;
}

/**
 * Готовая пара файлов для actions/upload-artifact.
 */
export interface PackedArtifact {
  /* Уникальное имя id-target-SHA. */
  readonly name: string;
  /* Абсолютный каталог с payload.tar и manifest.json. */
  readonly path: string;
}

/**
 * Проверенный bundle до распаковки; потребитель не меняет исходные байты между шагами.
 */
export interface VerifiedArtifact {
  /* Декларация разрешённого output. */
  readonly artifact: BuildArtifact;
  /* Абсолютный путь к проверенному payload.tar. */
  readonly archive: string;
}

/**
 * Подготовленная замена output; все записи находятся в одном checkout и файловой системе.
 */
export interface ArtifactPublication {
  /* Каталог назначения, принадлежащий каталогу BuildArtifact. */
  readonly destination: string;
  /* Проверенный распакованный каталог. */
  readonly prepared: string;
  /* Уникальный путь резервной копии для отката ошибки публикации. */
  readonly backup: string;
}

/**
 * Причина отказа передачи; тесты и вызывающие сценарии не зависят от текста диагностики.
 */
export type ArtifactErrorCode =
  | "ARTIFACT_INPUT"
  | "ARTIFACT_MISSING"
  | "ARTIFACT_METADATA"
  | "ARTIFACT_HASH"
  | "ARTIFACT_UNSAFE_ARCHIVE"
  | "ARTIFACT_HOST"
  | "ARTIFACT_TOOLCHAIN"
  | "ARTIFACT_IO";
