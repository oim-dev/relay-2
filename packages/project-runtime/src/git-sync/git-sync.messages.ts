/**
 * Диагностики локального запуска Git Sync и менеджеров пользовательской службы.
 */
export const gitSyncMessages = {
  binaryMissing:
    "Компонент relay-git-sync не найден. Соберите его рядом с relay либо задайте RELAY_GIT_SYNC_BIN.",
  invalidBinary: "RELAY_GIT_SYNC_BIN должен указывать на исполняемый файл.",
  invalidResponse: "Компонент Git Sync вернул несовместимый или повреждённый ответ.",
  requestIdRequired: "ID корреляции Git Sync должен быть непустой строкой.",
  conflictingRequestIds:
    "requestId ожидания и operationId нового запроса нельзя передавать одновременно.",
  requestWaitCancelled:
    "Ожидание ответа компонента прервано. Исход операции неизвестен; проверьте его по requestId.",
  invalidRequestJson:
    "Запрос Git Sync должен содержать только JSON-значения с конечными числами без потери полей при сериализации.",
  requestTooLarge: "Полный запрос Git Sync превышает допустимый размер процессного протокола.",
  incompatibleVersion:
    "Версии relay и relay-git-sync не совпадают. Установите компоненты одного выпуска.",
  processFailed: "Не удалось запустить дочерний процесс Git Sync.",
  processTimeout: "Превышено время ожидания дочернего процесса Git Sync.",
  processCancelled: "Запуск Git Sync отменён.",
  controlInvalid: "Локальный endpoint Git Sync повреждён или имеет неподдержанную форму.",
  supervisorNotReady:
    "Служба зарегистрирована, но supervisor не подтвердил готовность за отведённое время.",
  supervisorLockBusy: "Не удалось дождаться освобождения локальной блокировки supervisor.",
  outputLimit: "Вывод дочернего процесса превысил допустимый размер.",
  nativeFailed: "Системный менеджер пользовательской службы завершился с ошибкой.",
  invalidServicePath: "Путь службы содержит недопустимый управляющий символ.",
  serviceOwnership: "Конфигурация службы не принадлежит этому экземпляру Relay; файл сохранён.",
  servicePlatform: "Пользовательская служба доступна на Linux, macOS и Windows.",
  serviceIdentity: "Не удалось определить текущего пользователя для службы.",
  userHomeRequired: "Для пользовательской службы требуется явный домашний каталог пользователя.",
  allAndProject: "Параметры --all и --project несовместимы.",
  workspaceFailure: "Не удалось получить статус всех регистраций workspace.",
  linuxLogin:
    "Служба user-systemd запускается при входе пользователя. Работа до входа и после выхода требует отдельно настроенного linger; Relay его не включает.",
  macLogin: "LaunchAgent запускается в графической сессии текущего пользователя после входа.",
  windowsLogin:
    "Одна задача Task Scheduler поддерживает supervisor до service disable, в том числе после exit 0. Триггеры регистрации и входа текущего пользователя повторяются каждый с интервалом в одну минуту; это не общий лимит стартов или конечный счётчик рестартов.",
} as const;
