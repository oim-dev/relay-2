# Нативная приёмка пользовательских служб

Набор проверяет границу Project Runtime с настоящими `systemd --user`, LaunchAgent
и Task Scheduler. Он **устанавливает собственную службу текущего пользователя**
и предназначен только для одноразовой CI-машины с одноразовой учётной записью.
Он не входит в `check`, `test:all`, unit, integration или process.

## Запуск

Из корня подготовленного репозитория на одноразовом runner:

```bash
bun run build:cli
CI=true RELAY_NATIVE_SERVICE_TESTS=disposable-runner bun run test:native-service
```

Это синтаксис Bash, включая Git Bash на Windows. Без обоих значений команда
отклоняется до файловых операций fixture и обращения к manager. Прямой `bun test`
этого файла имеет ту же защиту. Флаг является явным согласием, а не способом
определить, что машина действительно одноразовая.

Нужна **уже существующая сессия текущего пользователя**:

- **Linux:** непривилегированный пользователь, работающий user-systemd и user bus
  в `XDG_RUNTIME_DIR`, доступный `loginctl show-user`. Если переменные адреса bus
  отсутствуют, используется `/run/user/<uid>/bus`. Настроенный `XDG_CONFIG_HOME`
  должен совпадать с обычным `~/.config`. Значение linger читается до и после
  сценария и обязано остаться прежним.
- **macOS:** непривилегированный пользователь с доступным `gui/<uid>` в launchd.
  SSH-only сессия без этого домена не подходит.
- **Windows:** runner запущен от текущего пользователя внутри уже открытой
  интерактивной сессии (не Session 0), доступен COM Task Scheduler.
  Задача обязана иметь `InteractiveToken`, `LeastPrivilege`, principal и logon trigger
  того же SID. Пароль, S4U, изменение UAC и вход пользователя тест не выполняет.

Preflight делает только чтения. Отсутствие manager/сессии проваливает набор,
а не превращает его в skip. Набор не создаёт login/GUI-сессии, не включает linger
и не повышает права.

## CI и граница доказательства

Отдельный job `native-services` в [CI](../../../../.github/workflows/ci.yml) запускает
этот набор на Linux, macOS и Windows. По умолчанию используются GitHub-hosted
`ubuntu-latest`, `macos-latest`, `windows-latest`; их label сам по себе **не гарантирует**
доступность user manager. В частности, Windows runner как служба в Session 0
не подходит для текущего InteractiveToken, а Linux runner может не иметь user bus.

При таком отказе инфраструктура должна предоставить одноразовый runner с уже
открытой требуемой сессией. Repository variables `RELAY_NATIVE_LINUX_RUNNER`,
`RELAY_NATIVE_MACOS_RUNNER`, `RELAY_NATIVE_WINDOWS_RUNNER` выбирают его label.
Ожидаемая ОС передаётся через `RELAY_NATIVE_SERVICE_PLATFORM`; ошибочно назначенный
label другой ОС отклоняется до setup, а не засчитывается за нужную платформу.
Для self-hosted это должен быть ephemeral runner в уничтожаемой после job VM,
допущенный политикой репозитория к выполнению его CI. Постоянный пользовательский
компьютер для этого label не подходит. Workflow не переустраивает сессию runner.

Сценарий использует публичный Runtime и собранный Git Sync без подмен manager,
native runner или health. Он проверяет:

1. Отсутствие уникальной регистрации перед установкой.
2. `enable`, native registration, health текущего instance и точный путь binary/home
   с пробелами и Unicode (также кавычками на POSIX).
3. Повторный `enable` с новым ready-instance и завершением прежнего PID.
4. Аварийный exit supervisor и **самостоятельный** restart manager с новым instance.
   На Windows ожидается production-интервал `RestartOnFailure=PT1M`.
5. `disable`, отсутствие регистрации, config, живых supervisor и отзывчивого health
   **до cleanup fixture**, побайтовую сохранность БД/привязки и чтение проекта.
6. Повторный `disable` и finally-уборку даже после незавершённого setup.

На Windows отдельно читаются зарегистрированная COM-конфигурация, SID владельца
процесса и настоящие argv через `CommandLineToArgvW`. На Linux PID сверяется
с `MainPID`, argv — с `/proc`; на macOS — с загруженным label и native-разбором plist.
Уборка имеет право затронуть только заранее свободный уникальный ID этого fixture.
Аварийный fallback, включая принудительное завершение подтверждённого health-процесса,
сохраняет отказ теста и не считается production cleanup.

Фактический logout/login, logon-trigger после нового входа и reboot здесь
**не проверяются**. Наличие login-конфигурации и запуск сейчас не доказывают эти
сценарии AC-30–32; для них нужен отдельный VM/session harness с внешним наблюдателем.
Process guardian, потеря foreground-parent lease и worker crash проверяются штатными
наборами на каждой ОС в соседнем job; этот набор не повторяет их и не доказывает
универсальное удержание произвольных macOS-демонов.

Журналы всех native-команд, наблюдения этапов и `result.json` сохраняются в
`.artifacts/YYYY-MM-DD/git-sync-implementation/finalization/native-service-ci/`.
Рабочие файлы удаляются после успешной уборки; при отказе cleanup сохраняются
для диагностики, а одноразовая VM должна быть уничтожена инфраструктурой.
