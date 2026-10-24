/**
 * Стабильные русские диагностики служебного интерфейса компонента.
 */
export const appMessages = {
  invalidRequest: "Недопустимый запрос Git Sync версии 1.",
  responseLimit: "Локальный ответ Git Sync превысил допустимый размер.",
  invalidResponse: "Владелец Git Sync вернул повреждённый control JSON.",
  version: "Версия процессного протокола Git Sync не поддерживается.",
  action: "Неизвестное действие Git Sync.",
  argument: "Недопустимые параметры действия Git Sync.",
  notConnected: "Git-синхронизация проекта не подключена.",
  state: "Локальное состояние Git Sync повреждено или несовместимо.",
  internal: "Не удалось выполнить действие Git Sync.",
  busy: "Владелец Git Sync уже запущен или не отвечает. Второй worker не запущен.",
  notReady: "Worker Git Sync не подтвердил готовность в установленное время.",
  supervisorRequired:
    "Нужен supervisor Git Sync. Запустите relay git-sync service enable или relay git-sync supervise.",
  supervisorNotRunning:
    "Supervisor Git Sync не отвечает. Запустите relay git-sync service enable или relay git-sync supervise.",
  controlChanged: "Предпочтения worker изменились во время запуска. Более новое решение сохранено.",
  workerCleanup: "Не удалось подтвердить полную очистку принадлежащего supervisor worker/job.",
  leaseLost: "Потеряно соединение с владельцем сетевого бюджета. Git attempt отменён.",
  waitTimeout: "Истекло время ожидания результата. Запрос принят; узнайте его исход по requestId.",
  outcomeUnknown:
    "Достоверный исход этого requestId неизвестен или истёк срок его хранения. Операция не запущена повторно.",
  incompatible: "Запущенный worker имеет несовместимую версию протокола или другую идентичность.",
  auth: "Локальный запрос Git Sync не авторизован.",
  conflictMissing: "Конфликт синхронизации не найден.",
  conflicts:
    "Остались предметные конфликты синхронизации; фактический остаток очереди указан в status.pending.",
  blockedResolution:
    "Пакет ожидает принятия зависимостей и не имеет сторон для resolve. Проверьте dependencies через conflicts get; после их принятия продолжите обмен.",
  remoteRequired: "Для восстановления новой реплики укажите remote.",
  resumeArguments:
    "Resume подключает сохранённую БД без remote/branch; projectId допустим только вместе с resume.",
  resumed:
    "Подключено сохранённое локальное состояние, включая поздние принятые записи. Новый remote snapshot не применялся.",
  help: "Relay Git Sync — служебный компонент. Используйте relay git-sync --help.\nСлужебные входы: --request; supervise --home <путь>; worker --config <путь> --home <путь>.",
} as const;
