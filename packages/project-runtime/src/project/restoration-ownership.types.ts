/**
 * Физическая идентичность файла на хосте; десятичные строки сохраняют все биты BigInt stat.
 * mtime/ctime не входят в идентичность: поздние принятые записи не меняют владельца inode.
 */
export interface RestorationFileIdentity {
  /* Устройство/том локального файла. */
  readonly device: string;
  /* Ненулевой inode/File ID, без преобразования через небезопасный number. */
  readonly inode: string;
  /* Время создания файла в наносекундах; смена inode с повторным использованием номера не принимается. */
  readonly birthtimeNs: string;
}

/**
 * Одно наблюдение обычного файла; links используется только для отказа от неизвестных алиасов staging.
 */
export interface RestorationFileObservation {
  /* Идентичность, не зависящая от изменения содержимого. */
  readonly identity: RestorationFileIdentity;
  /* Текущее число hardlinks; не используется как разрешение удалить публичную БД. */
  readonly links: bigint;
}

/**
 * Переносимая причина незавершённой уборки уже подключённого проекта.
 */
export interface RestorationCleanupFailure {
  /* Код Relay либо исходный код файловой системы; IO_ERROR без доступного системного кода. */
  readonly code: string;
  /* Полное пояснение отказа либо сохранения неизвестных companion-файлов. */
  readonly message: string;
}
