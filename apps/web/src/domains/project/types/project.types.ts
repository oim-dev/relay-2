import type { ReactNode } from "react";
import type { BatchResult, HttpEntityPage, NamedCommand, ProjectEntity } from "@relay/contracts";

/**
 * Неизменяемая идентичность области чтения, записи и черновиков.
 */
export interface ProjectScopeValue {
  /* Постоянный ID выбранного проекта. */
  readonly projectId: string;
  /* Явный автор команды из контекста сервера. */
  readonly actor: string;
  /* Origin сервера, отделяющий кеш и локальные черновики. */
  readonly serverKey: string;
}

/**
 * Область React-дерева выбранного проекта.
 */
export interface ProjectScopeProps extends ProjectScopeValue {
  /* Рабочая область проекта. */
  readonly children: ReactNode;
}

/**
 * Карточка и исходный переносимый guard одного согласованного чтения.
 */
export interface VersionedEntity {
  /* Проверенная предметная карточка. */
  readonly entity: ProjectEntity;
  /* Aggregate token для записи, если сервер предоставил его. */
  readonly expectedVersion?: string;
}

/**
 * Накопленные страницы одного поколения; смена поколения требует явного обновления.
 */
export interface EntityPages {
  /* Только карточки согласованных страниц. */
  readonly items: ProjectEntity[];
  /* Общее количество из первой страницы; undefined до успешного чтения. */
  readonly total: number | undefined;
  /* Выполняется первоначальное чтение или продолжение. */
  readonly loading: boolean;
  /* Ошибка чтения, включая PAGE_CHANGED. */
  readonly error: unknown;
  /* Продолжает набор с исходным generation. */
  readonly loadMore: () => void;
  /* Следующая страница существует. */
  readonly hasMore: boolean;
  /* Сбрасывает окно и перечитывает набор. */
  readonly reload: () => void;
}

/**
 * Клиентский черновик живёт в памяти вкладки отдельно от GET-кеша.
 */
export interface DraftState<T> {
  /* Несохранённое значение; никогда не обновляется из SSE. */
  readonly value: T;
  /* Меняет черновик только текущего смонтированного владельца. */
  readonly setValue: (value: T) => void;
  /* Сбрасывает текущий черновик после известного результата либо явной отмены. */
  readonly reset: () => void;
}

/**
 * Сохранённый неопределённый запрос запрещает подмену input и operationKey.
 */
export interface CommandDraftValue {
  /* Замороженный запрос до известного результата. */
  readonly command?: NamedCommand;
  /* Идемпотентный ключ замороженной команды. */
  readonly operationKey?: string;
  /* Ошибка, пригодная для отображения в форме. */
  readonly error?: string;
  /* Неизвестно, завершилась ли запись; исправление полей заблокировано. */
  readonly uncertain: boolean;
}

/**
 * Обработчик формы с сохранением первоначального запроса после потери ответа.
 */
export interface CommandDraft {
  /* Отправляет новое действие или проверяет первоначальный frozen запрос. */
  readonly submit: (command: NamedCommand) => Promise<BatchResult | undefined>;
  /* Читает квитанцию сохранённого ключа без POST; отсутствие результата сохраняет frozen draft. */
  readonly recover: () => Promise<BatchResult | undefined>;
  /* Есть незавершённый HTTP-вызов этой формы. */
  readonly pending: boolean;
  /* Нельзя менять ввод до установления исхода первоначального запроса. */
  readonly uncertain: boolean;
  /* Сообщение последней попытки, отсутствует до ошибки. */
  readonly error: string | undefined;
  /* Удаляет только окончательную ошибку, не отбрасывает unresolved запрос. */
  readonly reset: () => void;
}

/**
 * Прямой исполнитель предметной команды с явным ключом вызывающего.
 */
export interface ProjectCommand {
  /* Выполняет первоначальную команду либо проверяет её квитанцию при повторе ключа. */
  readonly execute: (command: NamedCommand, operationKey: string) => Promise<BatchResult>;
  /* Проверяет только ранее выданный ключ; никогда не исполняет предметную команду. */
  readonly recover: (operationKey: string) => Promise<BatchResult>;
  /* Выполняется обращение этого экземпляра. */
  readonly pending: boolean;
}

/**
 * Полная текущая страница без локальных предметных пересчётов.
 */
export type ServerEntityPage = HttpEntityPage;

/**
 * Состояние соединения SSE не описывает Git-доставку.
 */
export type ProjectConnection = "connecting" | "connected" | "reconnecting" | "storage-error";
