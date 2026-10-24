/**
 * Безопасная техническая часть одной причины fatal-ошибки supervisor.
 * Тексты, stack, paths, details, argv, окружение и control capability не сохраняются.
 */
export interface SupervisorFailureCause {
  /* ASCII code до 64 символов A-Z/0-9/_, начиная с буквы; null при неподходящем значении. */
  readonly code: string | null;
  /* Безопасный целый exit code RelayError; null при отсутствии или неверном значении. */
  readonly exitCode: number | null;
  /* Безопасный целый errno; null при отсутствии или неверном значении. */
  readonly errno: number | null;
  /* Безопасный целый Win32-код; null при отсутствии или неверном значении. */
  readonly win32Code: number | null;
}

/**
 * Один fatal-исход supervise, дополнительно сохранённый в уже выбранном физическом home.
 * Не является readiness или доказательством владения процессом; прежняя ошибка пробрасывается.
 */
export interface SupervisorFailureRecord {
  /* Версия локального диагностического файла. */
  readonly version: 1;
  /* Отличает запись от control endpoint и предметных данных. */
  readonly kind: "supervisor-failure";
  /* Уникальный идентификатор попытки записать диагностический файл. */
  readonly attemptId: string;
  /* PID завершившегося supervisor; только для сопоставления с native manager. */
  readonly pid: number;
  /* UTC-время наблюдения ошибки, а не время readiness. */
  readonly observedAt: string;
  /* Не более шести причин: сначала исходная ошибка, затем её cause. */
  readonly causes: readonly SupervisorFailureCause[];
}
