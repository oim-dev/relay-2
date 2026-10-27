import type { ArtifactErrorCode } from "./artifacts.types";

/**
 * Ошибка передачи с независимым от локализованного текста кодом и исходной причиной.
 */
export class ArtifactError extends Error {
  /* Стабильная причина отказа на границе CI. */
  readonly code: ArtifactErrorCode;

  /**
   * Сохраняет код и исходную ошибку файловой системы, JSON либо tar.
   */
  constructor(code: ArtifactErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArtifactError";
    this.code = code;
  }
}
