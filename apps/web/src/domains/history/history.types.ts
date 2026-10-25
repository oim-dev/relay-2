import type { HistoryCheckpoint, HistorySession } from "@relay/contracts";
/**
 * Исходный снимок владельца записи истории; checkpoint и fork защищены ревизией сессии.
 */
export interface HistorySource {
  /* Полная сессия из versioned read. */
  readonly entity: HistorySession;
  /* Переносимая версия того же владельца; отсутствие допускает числовой CAS. */
  readonly expectedVersion?: string;
}
/**
 * Доступная операция сессии; допустимость состояния проверяется Core.
 */
export type SessionAction = SessionChange["action"];
/**
 * Точный ввод перехода сессии, соответствующий каталогу Core.
 */
export type SessionChange =
  | {
      /* Начинает корневую сессию с новым активным участием. */
      readonly action: "start";
      /* Непустой однострочный заголовок новой работы. */
      readonly title: string;
      /* Непустое описание, если передано; отсутствие сохраняется как null в Core. */
      readonly description?: string;
    }
  | {
      /* Создаёт дочернее поручение из открытого намерения. */
      readonly action: "fork";
      /* Непустой однострочный заголовок поручения. */
      readonly title: string;
      /* Необязательное непустое описание поручения. */
      readonly description?: string;
      /* Постоянный ID исходного активного участия родителя. */
      readonly runId: string;
      /* Прочитанное открытое намерение родительской сессии. */
      readonly intent: HistoryCheckpoint;
    }
  | {
      /* Принимает pending-поручение либо продолжает paused-сессию. */
      readonly action: "attach" | "resume";
      /* Необязательное непустое объяснение подключения. */
      readonly reason?: string;
    }
  | {
      /* Принимает ответственность за открытую сессию новым участием. */
      readonly action: "takeover";
      /* Обязательное объяснение передачи ответственности. */
      readonly reason: string;
    }
  | {
      /* Заканчивает текущее участие с приостановкой сессии. */
      readonly action: "pause";
      /* Постоянный ID исходного активного участия. */
      readonly runId: string;
      /* Обязательное объяснение приостановки. */
      readonly reason: string;
    }
  | {
      /* Закрывает сессию с результатом либо отменой. */
      readonly action: "complete" | "cancel";
      /* ID активного участия; отсутствует при отмене pending/paused-сессии. */
      readonly runId?: string;
      /* Обязательный результат или причина отмены. */
      readonly result: string;
    };
