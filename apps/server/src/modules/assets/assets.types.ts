/**
 * Готовый файл Web; Blob также принимает embedded BunFile без распаковки на диск.
 */
export interface WebAsset {
  /* Исходные байты готового Vite output. */
  readonly body: Blob;
  /* MIME исходного публичного имени, не внутреннего имени Bun embedding. */
  readonly contentType: string;
  /* Размер исходного файла в байтах; сохраняется также для HEAD. */
  readonly size: number;
  /* Сильный SHA-256 validator в двойных кавычках. */
  readonly etag: string;
  /* Только Vite hash assets; HTML всегда требует revalidation. */
  readonly immutable: boolean;
}

/**
 * Build-time запись готового dist для генерации file imports.
 */
export interface WebAssetFile extends Omit<WebAsset, "body"> {
  /* Канонический публичный URL с encoded сегментами. */
  readonly url: string;
  /* Абсолютный build-time файл; runtime executable его не читает. */
  readonly source: string;
  /* Snapshot байтов для source/dev режима. */
  readonly bytes: Uint8Array<ArrayBuffer>;
}
