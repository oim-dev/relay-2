/**
 * DI token явной конфигурации сервера. Не читает environment при импорте модулей.
 */
export const SERVER_OPTIONS = Symbol("RelayServerOptions");
