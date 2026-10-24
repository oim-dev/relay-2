import { RelayError } from "../errors/relay-error";
import {
  ACTOR_LENGTH,
  ENTITY_KINDS,
  ENTITY_SLUG_LENGTH,
  PROJECT_NAME_LENGTH,
} from "./identity.constants";
import { identityMessages } from "./identity.messages";
import type { EntityKind } from "./identity.types";
import { isPortableIdentityText } from "../replication/portable-identity";

/**
 * Проверяет принадлежность внешнего значения перечню видов локальных сущностей.
 */
export function isEntityKind(value: unknown): value is EntityKind {
  return typeof value === "string" && ENTITY_KINDS.some((kind) => kind === value);
}

/**
 * Проверяет уже каноническое имя проекта без нормализации и исключений.
 * Длина ограничена PROJECT_NAME_LENGTH; краевые пробельные символы,
 * управляющие символы Unicode и разделители строк U+2028/U+2029 запрещены.
 * Внутренние пробелы допустимы. Нормализацией внешнего ввода владеет вызывающая граница.
 */
export function isProjectName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= PROJECT_NAME_LENGTH.min &&
    value.length <= PROJECT_NAME_LENGTH.max &&
    !/^\s|\s$|[\p{Cc}\u2028\u2029]/u.test(value)
  );
}

/**
 * Проверяет slug проекта, приложения или доски без нормализации и исключений.
 * Длина ограничена ENTITY_SLUG_LENGTH; части из строчных латинских букв и цифр
 * разделяются одиночными дефисами. Выбор значения по умолчанию принадлежит вызывающей границе.
 */
export function isEntitySlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= ENTITY_SLUG_LENGTH.min &&
    value.length <= ENTITY_SLUG_LENGTH.max &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
  );
}

/**
 * Проверяет идентичность автора и возвращает исходную строку без нормализации.
 * Краевые пробелы, управляющие символы и разделители строк запрещены;
 * длина ограничена ACTOR_LENGTH. Непарный UTF-16 отклоняется до SQL TEXT binding.
 * Исправление текста изменило бы владельца участия.
 *
 * @throws RelayError с кодом INVALID_ARGUMENT и полем actor при неверном значении.
 */
export function validateActor(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < ACTOR_LENGTH.min ||
    value.length > ACTOR_LENGTH.max ||
    !isPortableIdentityText(value) ||
    value !== value.trim() ||
    /[\p{Cc}\u2028\u2029]/u.test(value)
  ) {
    throw new RelayError("INVALID_ARGUMENT", identityMessages.invalidActor, 2, { field: "actor" });
  }
  return value;
}
