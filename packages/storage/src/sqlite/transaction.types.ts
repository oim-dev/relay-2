/**
 * Синхронная операция: Promise запрещён статически и дополнительно проверяется при вызове.
 */
export type SynchronousOperation<T> = () => T & (T extends PromiseLike<unknown> ? never : unknown);

/**
 * Режим внешней транзакции: запись сразу получает mutex, снимок начинается первым чтением.
 */
export type TransactionMode = "IMMEDIATE" | "DEFERRED";
