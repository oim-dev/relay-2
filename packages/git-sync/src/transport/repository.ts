import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { RelayError } from "@relay/contracts";
import { checkGit, git, requireGit } from "./git";
import type { GitCounts, GitFiles, GitHistoryEntry, RepositoryOptions } from "./repository.types";
import type { ProcessInput, ProcessResult } from "./process.types";
import { transportMessages } from "./transport.messages";
import { selectSshProfile } from "./ssh-profile";
import type { SshProfile } from "./ssh-profile.types";
import { repositoryStateDirectory, saveSshCapability } from "./ssh-state";
import { isGitObjectId, readGitObjects, readGitTrees } from "./git-objects";
import { importGitSnapshot } from "./git-import";
import { redact } from "./process";
import { initializeDataWorktree, materializeDataWorktree } from "./worktree";
import { worktreeGitArguments } from "./worktree-profile";

const MAX_TREE_BYTES = 128 * 1024 * 1024;

/**
 * Владеет Git-механикой: общая remote-ветка, linked checkout либо legacy bare и только FF push.
 * Вызывающий сериализует операции одного экземпляра; SQL и предметный merge сюда не входят.
 */
export class DataRepository {
  /* Технические refs отдельной реплики; в linked Git не пересекаются с ветками исходников. */
  private readonly localRef: string;
  /* Последний проверенный remote текущей реплики. */
  private readonly remoteRef: string;
  /* Git-якорь фактически принятого Core состояния. */
  private readonly acceptedRef: string;
  /* Временный ref fast-import; не является подтверждением публикации. */
  private readonly preparedRef: string;
  /* Узкий набор refs для единственного cold read. */
  private readonly stateRefs: readonly string[];
  /* Параметры приватного репозитория и ограничений дочерних процессов. */
  readonly options: RepositoryOptions;
  /* Проверенный local ref этого владельца; undefined ещё не прочитан, null отсутствует. */
  private localHead: string | null | undefined;
  /* Проверенный remote ref этого владельца; обновляется только после validation. */
  private remoteHead: string | null | undefined;
  /* Точный Git commit после Core acceptance; отличается от fetched и неподтверждённого candidate. */
  private acceptedHead: string | null | undefined;
  /* Общий cold read для параллельных local/remote/accepted запросов одного сериализованного owner. */
  private readingRefs: Promise<void> | null = null;
  /* Профиль текущей попытки; null command сохраняет все пользовательские SSH overrides. */
  private sshProfile: SshProfile | undefined;
  /* Ограниченный cache default probe, полученного в точном Git окружении. */
  private defaultSshProfile: SshProfile | undefined;
  /* Дополнительная отмена текущего cycle/сетевого lease; не переживает run engine. */
  private attemptSignal: AbortSignal | null = null;
  /* Точная пара refs для только что созданного прямого потомка; любые другие пары считаются Git rev-list. */
  private directCounts: GitCounts | null = null;

  /**
   * Сохраняет параметры без сетевых и файловых операций.
   */
  constructor(options: RepositoryOptions) {
    this.options = options;
    const replicaId = options.worktree?.replicaId;
    if (
      options.worktree !== undefined &&
      [options.worktree.projectId, options.worktree.replicaId].some(
        (id) => typeof id !== "string" || !/^[a-zA-Z0-9-]+$/.test(id),
      )
    ) {
      throw new RelayError("GIT_INVALID_REPOSITORY", transportMessages.invalidRepository, 4);
    }
    const prefix = replicaId === undefined ? "refs/relay" : `refs/relay/${replicaId}`;
    this.localRef = replicaId === undefined ? "refs/heads/data" : `${prefix}/local`;
    this.remoteRef = `${prefix}/remote`;
    this.acceptedRef = `${prefix}/accepted`;
    this.preparedRef = `${prefix}/prepared`;
    this.stateRefs = [this.localRef, this.remoteRef, this.acceptedRef];
  }

  /**
   * Объединяет отмену владельца, текущего attempt и отдельной команды без потери SSH overrides.
   */
  private executionOptions(extra: Partial<ProcessInput> = {}): Partial<ProcessInput> {
    const signals = [this.options.signal, this.attemptSignal, extra.signal].filter(
      (signal): signal is AbortSignal => signal !== undefined && signal !== null,
    );
    return {
      ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
      ...extra,
      ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
      env: {
        ...this.options.env,
        ...(this.sshProfile?.command ? { GIT_SSH_COMMAND: this.sshProfile.command } : {}),
        ...extra.env,
        ...(this.options.worktree === undefined
          ? {}
          : { GIT_ATTR_NOSYSTEM: "1", GIT_ATTR_SOURCE: undefined }),
      },
    };
  }

  /**
   * Запускает Git в основном или служебном каталоге под одним guardian/attempt-профилем.
   */
  private runAt(
    directory: string,
    args: readonly string[],
    extra: Partial<ProcessInput> = {},
  ): Promise<ProcessResult> {
    return git(
      directory,
      this.options.worktree === undefined ? args : worktreeGitArguments(args),
      this.executionOptions(extra),
    );
  }

  /**
   * Выполняет одну команду в принадлежащем реплике linked worktree либо bare-репозитории.
   */
  private run(args: readonly string[], extra: Partial<ProcessInput> = {}): Promise<ProcessResult> {
    return this.runAt(this.options.directory, args, extra);
  }

  /**
   * Привязывает все последующие дочерние Git команды к живому attempt lease.
   */
  setAttemptSignal(signal: AbortSignal | null): void {
    this.attemptSignal = signal;
  }

  /**
   * Создаёт/проверяет собственный linked worktree либо legacy bare; чужой checkout не исправляет.
   * Ручные изменения, неподдержанные checkout attributes и несовпадение origin bare дают отказ.
   */
  async initialize(): Promise<void> {
    if (this.options.worktree !== undefined) {
      await initializeDataWorktree(
        this.options,
        (cwd, args, extra) => this.runAt(cwd, args, extra),
        [...this.stateRefs, this.preparedRef],
      );
      return;
    }
    mkdirSync(this.options.directory, { recursive: true, mode: 0o700 });
    if (!existsSync(`${this.options.directory}/HEAD`)) {
      if (readdirSync(this.options.directory).length > 0) {
        throw new RelayError("GIT_INVALID_REPOSITORY", transportMessages.invalidRepository, 4);
      }
      requireGit(await this.run(["init", "--bare", "--initial-branch=data", "."]), "init");
      requireGit(await this.run(["remote", "add", "origin", this.options.remote]), "remote-add");
    }
    const bare = requireGit(
      await this.run(["rev-parse", "--is-bare-repository"]),
      "verify-repository",
    );
    if (bare !== "true") {
      throw new RelayError("GIT_INVALID_REPOSITORY", transportMessages.invalidRepository, 4);
    }
    await this.verifyOrigin();
  }

  /**
   * Проверяет оба эффективных URL перед сетью, включая отдельный pushurl и глобальные rewrites.
   * Linked transport использует literal URL: временное имя remote моделирует его Git rewrites без записи config.
   * Поэтому named origin.pushurl не может скрыть pushInsteadOf, который подействует при push по literal URL.
   */
  private async verifyOrigin(): Promise<void> {
    if (this.options.worktree !== undefined) {
      const name = `relay-check-${crypto.randomUUID()}`;
      // get-url не считает -c-only remote настроенным. show -n читает оба URL без сети.
      // Метки стабильны в заданном gitCommand окружении LC_ALL=C; неполный ответ отклоняется.
      const output = requireGit(
        await this.run([
          "-c",
          `remote.${name}.url=${this.options.remote}`,
          "remote",
          "show",
          "-n",
          name,
        ]),
        "verify-remote-url",
      ).replaceAll("\r\n", "\n");
      const fetchUrls = [...output.matchAll(/^  Fetch URL: (.*)$/gm)].map((match) => match[1]);
      const pushUrls = [...output.matchAll(/^  Push  URL: (.*)$/gm)].map((match) => match[1]);
      if (
        fetchUrls.length !== 1 ||
        pushUrls.length !== 1 ||
        fetchUrls[0] !== this.options.remote ||
        pushUrls[0] !== this.options.remote
      ) {
        throw new RelayError("GIT_ORIGIN_MISMATCH", transportMessages.originMismatch, 4);
      }
      return;
    }
    const remote = requireGit(
      await this.run(["remote", "get-url", "--all", "origin"]),
      "verify-origin",
    );
    const push = requireGit(
      await this.run(["remote", "get-url", "--push", "--all", "origin"]),
      "verify-push-origin",
    );
    if (remote !== this.options.remote || push !== this.options.remote) {
      throw new RelayError("GIT_ORIGIN_MISMATCH", transportMessages.originMismatch, 4);
    }
  }

  /**
   * Читает служебные refs общей холодной пачкой; произвольный ref — отдельным rev-parse.
   * Отсутствие возвращается как null, инфраструктурная ошибка не превращается в пустой ref.
   */
  async ref(name: string): Promise<string | null> {
    if (
      this.stateRefs.includes(name) &&
      (this.localHead === undefined ||
        this.remoteHead === undefined ||
        this.acceptedHead === undefined)
    ) {
      this.readingRefs ??= this.readRefs();
      try {
        await this.readingRefs;
      } finally {
        this.readingRefs = null;
      }
    }
    let cached: string | null | undefined;
    if (name === this.localRef) {
      cached = this.localHead;
    } else if (name === this.remoteRef) {
      cached = this.remoteHead;
    } else if (name === this.acceptedRef) {
      cached = this.acceptedHead;
    }
    if (cached !== undefined) {
      return cached;
    }
    const result = await this.run(["rev-parse", "--verify", "--quiet", name]);
    const head = result.exitCode === 1 ? null : requireGit(result, "read-ref");
    if (name === this.localRef) {
      this.localHead = head;
    }
    if (name === this.remoteRef) {
      this.remoteHead = head;
    }
    if (name === this.acceptedRef) {
      this.acceptedHead = head;
    }
    return head;
  }

  /**
   * Читает три служебных refs одним Git запросом; отсутствие каждого сохраняется как null.
   * show-ref отклоняет broken refs кодом выхода, не смешивая их с пользовательским trace в stderr.
   * Cache публикуется целиком после разбора; exit 1 допустим только с пустым stdout (нет совпадений).
   */
  private async readRefs(): Promise<void> {
    const result = await this.run(["show-ref", "--", ...this.stateRefs]);
    if (result.exitCode !== 0 && !(result.exitCode === 1 && result.stdout.length === 0)) {
      throw new RelayError("GIT_INVALID_REPOSITORY", transportMessages.invalidRepository, 4, {
        operation: "read-state-refs",
        exitCode: result.exitCode,
        reason: redact(result.stderr.subarray(-8192).toString("utf8")),
      });
    }
    const output = result.stdout.toString("utf8").trim();
    const refs = new Map<string, string>();
    for (const line of output.split("\n").filter(Boolean)) {
      const [head, name, ...extra] = line.split(" ");
      // show-ref сопоставляет окончания имён по компонентам; принимаем только exact служебные refs.
      if (name === undefined || !this.stateRefs.includes(name)) {
        continue;
      }
      if (head === undefined || !isGitObjectId(head) || extra.length !== 0 || refs.has(name)) {
        throw new RelayError("GIT_INVALID_REPOSITORY", transportMessages.invalidRepository, 4);
      }
      refs.set(name, head);
    }
    this.localHead = refs.get(this.localRef) ?? null;
    this.remoteHead = refs.get(this.remoteRef) ?? null;
    this.acceptedHead = refs.get(this.acceptedRef) ?? null;
  }

  /**
   * Получает только общую ветку без tags. Ошибка сети не трактуется как пустой remote.
   * Известная история может только продвигаться; rewind или удаление ветки дают явный отказ.
   */
  async fetch(): Promise<string | null> {
    await this.verifyOrigin();
    this.sshProfile = await selectSshProfile(
      { ...this.options, ...this.executionOptions() },
      this.defaultSshProfile,
    );
    if (this.sshProfile.capability.source === "default") {
      this.defaultSshProfile = this.sshProfile;
    }
    saveSshCapability(repositoryStateDirectory(this.options), this.sshProfile.capability);
    const known = await this.ref(this.remoteRef);
    const advertised = await this.run([
      "ls-remote",
      "--exit-code",
      "--heads",
      this.options.remote,
      `refs/heads/${this.options.branch}`,
    ]);
    if (advertised.exitCode === 2) {
      if (known !== null) {
        throw new RelayError("GIT_BRANCH_MISSING", transportMessages.missing, 4);
      }
      return null;
    }
    const advertisedHead = requireGit(advertised, "ls-remote");
    if (known !== null && advertisedHead === `${known}\trefs/heads/${this.options.branch}`) {
      return known;
    }
    requireGit(
      await this.run([
        "fetch",
        "--no-tags",
        "--no-recurse-submodules",
        this.options.remote,
        `refs/heads/${this.options.branch}`,
      ]),
      "fetch",
    );
    const head = requireGit(
      await this.run(["rev-parse", "--verify", "FETCH_HEAD^{commit}"]),
      "fetch-head",
    );
    if (known !== null && !(await this.isAncestor(known, head))) {
      throw new RelayError("GIT_UNRELATED_HISTORY", transportMessages.unrelated, 4);
    }
    return head;
  }

  /**
   * Отмечает только уже декодированный и предметно проверенный remote head.
   */
  async rememberRemote(head: string): Promise<void> {
    if (this.remoteHead === head) {
      return;
    }
    requireGit(await this.run(["update-ref", this.remoteRef, head]), "remember-remote");
    this.remoteHead = head;
  }

  /**
   * Проверяет достижимость без смешивания отказа команды с отсутствием родства.
   */
  async isAncestor(ancestor: string, head: string): Promise<boolean> {
    if (ancestor === head) {
      return true;
    }
    const result = await this.run(["merge-base", "--is-ancestor", ancestor, head]);
    if (result.exitCode === 1) {
      return false;
    }
    requireGit(result, "ancestry");
    return true;
  }

  /**
   * Загружает ограниченное дерево напрямую из object database, не создавая файлов checkout.
   * Symlink, submodule, исполняемые файлы и некорректные пути отвергаются до чтения blob.
   */
  async files(head: string): Promise<Map<string, Uint8Array>> {
    const listing = await this.run(["ls-tree", "-r", "-z", "--full-tree", head]);
    requireGit(listing, "ls-tree");
    const records = listing.stdout.toString("utf8").split("\0").filter(Boolean);
    if (records.length > 100_000) {
      throw new RelayError("GIT_OUTPUT_LIMIT", transportMessages.outputLimit);
    }
    const entries = records.map((record) => {
      const match = /^100644 blob ([a-f0-9]{40,64})\t([a-zA-Z0-9_./-]+)$/.exec(record);
      if (
        !match?.[1] ||
        !match[2] ||
        match[2].split("/").some((part) => part === "." || part === ".." || !part)
      ) {
        throw new RelayError("GIT_INVALID_SNAPSHOT", transportMessages.invalidRepository, 4);
      }
      return { oid: match[1], path: match[2] };
    });
    const blobs = await this.run(["cat-file", "--batch"], {
      input: entries.map((entry) => entry.oid).join("\n") + "\n",
      maxBytes: MAX_TREE_BYTES,
    });
    checkGit(blobs, "cat-file");
    const files = new Map<string, Uint8Array>();
    let offset = 0;
    for (const entry of entries) {
      const newline = blobs.stdout.indexOf(10, offset);
      const header = blobs.stdout.subarray(offset, newline).toString("ascii");
      const match = /^([a-f0-9]{40,64}) blob (\d+)$/.exec(header);
      const size = Number(match?.[2]);
      if (
        !match ||
        match[1] !== entry.oid ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        newline < offset ||
        newline + size + 1 >= blobs.stdout.length
      ) {
        throw new RelayError("GIT_INVALID_SNAPSHOT", transportMessages.invalidRepository, 4);
      }
      files.set(entry.path, blobs.stdout.subarray(newline + 1, newline + 1 + size));
      offset = newline + size + 2;
    }
    if (offset !== blobs.stdout.length) {
      throw new RelayError("GIT_INVALID_SNAPSHOT", transportMessages.invalidRepository, 4);
    }
    return files;
  }

  /**
   * Записывает raw snapshot на remote parent через private fast-import ref данной реплики.
   * Совпадающее дерево возвращает parent. Затем обновляет только проверенный чистый checkout и local ref.
   * При отказе checkout временный prepared ref может сохраниться; это не Core acceptance или push.
   */
  async commit(files: GitFiles, parent: string | null): Promise<string> {
    const commit = await importGitSnapshot(
      (args, options) => this.run(args, options),
      files,
      parent,
      this.preparedRef,
    );
    await materializeDataWorktree(this.options, commit, (cwd, args, extra) =>
      this.runAt(cwd, args, extra),
    );
    requireGit(await this.run(["update-ref", this.localRef, commit]), "local-head");
    this.localHead = commit;
    this.directCounts =
      parent !== null && this.remoteHead === parent
        ? { localHead: commit, remoteHead: parent, ahead: commit === parent ? 0 : 1, behind: 0 }
        : null;
    return commit;
  }

  /**
   * Повторно проверяет destination и публикует только обычным FF push.
   * Любой неуспех требует проверки remote вызывающим; смена конфигурации не даёт ACK другой ветки.
   */
  async push(commit: string): Promise<ProcessResult> {
    await this.verifyOrigin();
    return this.run([
      "-c",
      "remote.origin.mirror=false",
      "push",
      "--porcelain",
      "--no-follow-tags",
      this.options.remote,
      `${commit}:refs/heads/${this.options.branch}`,
    ]);
  }

  /**
   * После Core acceptance материализует чистый checkout и атомарно обновляет три private refs.
   * Проверка checkout действует и при no-op; отказ Git не откатывает уже выполненный Core commit.
   */
  async accepted(head: string): Promise<void> {
    await materializeDataWorktree(this.options, head, (cwd, args, extra) =>
      this.runAt(cwd, args, extra),
    );
    const updates: string[] = [];
    if (this.localHead !== head) {
      updates.push(`update ${this.localRef} ${head}`);
    }
    if (this.remoteHead !== head) {
      updates.push(`update ${this.remoteRef} ${head}`);
    }
    if (this.acceptedHead !== head) {
      updates.push(`update ${this.acceptedRef} ${head}`);
    }
    if (updates.length === 0) {
      return;
    }
    // update-ref --stdin подтверждает всю группу refs одной Git transaction и одним guardian запуском.
    requireGit(
      await this.run(["update-ref", "--stdin"], { input: updates.join("\n") + "\n" }),
      "accept-heads",
    );
    this.localHead = head;
    this.remoteHead = head;
    this.acceptedHead = head;
  }

  /**
   * Читает именно Core-accepted cursor; fetched remote не подменяет прикладную базу replay.
   */
  acceptedCommit(): Promise<string | null> {
    return this.ref(this.acceptedRef);
  }

  /**
   * Возвращает все непосредственные Git edges после anchor в прямом порядке, без first-parent пропусков.
   * Merge, разрыв, дополнительный root или посторонняя история отвергаются до Core replay.
   */
  async history(head: string, after: string | null): Promise<GitHistoryEntry[]> {
    if (after === head) {
      return [];
    }
    const output = requireGit(
      await this.run([
        "rev-list",
        "--reverse",
        "--topo-order",
        "--parents",
        after ? `${after}..${head}` : head,
      ]),
      "publication-history",
    );
    const result: GitHistoryEntry[] = [];
    let expectedParent = after;
    for (const line of output.split("\n")) {
      const [commit, ...parents] = line.split(" ");
      if (
        !commit ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) ||
        parents.length > 1 ||
        (parents[0] ?? null) !== expectedParent
      ) {
        throw new RelayError("GIT_UNRELATED_HISTORY", transportMessages.unrelated, 4);
      }
      result.push({ head: commit, parent: parents[0] ?? null });
      expectedParent = commit;
    }
    if (expectedParent !== head) {
      throw new RelayError("GIT_UNRELATED_HISTORY", transportMessages.unrelated, 4);
    }
    const objects = await readGitObjects(
      (args, options) => this.run(args, options),
      result.map((entry) => entry.head),
    );
    for (const [index, object] of objects.entries()) {
      const entry = result[index];
      const bytes = Buffer.from(object.bytes);
      const separator = bytes.indexOf("\n\n");
      const header = bytes.subarray(0, separator < 0 ? bytes.length : separator).toString("utf8");
      const parents = [...header.matchAll(/^parent ([a-f0-9]+)$/gm)].map((match) => match[1]);
      if (
        !entry ||
        object.kind !== "commit" ||
        parents.length > 1 ||
        (parents[0] ?? null) !== entry.parent
      ) {
        throw new RelayError("GIT_UNRELATED_HISTORY", transportMessages.unrelated, 4);
      }
    }
    return result;
  }

  /**
   * Читает цепочку snapshots без отдельного cat-file/hash subprocess на каждую карточку.
   */
  filesMany(heads: readonly string[]): Promise<Map<string, Map<string, Uint8Array>>> {
    return readGitTrees((args, options) => this.run(args, options), heads);
  }

  /**
   * Загружает уже проверенные объекты staging restore без remote-сети и без смены local/remote refs.
   * Старый known remote обязан быть предком; восстановление не легализует переписанную историю.
   */
  async importObjects(source: string, head: string): Promise<void> {
    const known = await this.ref(this.remoteRef);
    requireGit(
      await this.run(["fetch", "--no-tags", "--no-recurse-submodules", source, "refs/heads/data"]),
      "restore-objects",
    );
    const fetched = requireGit(
      await this.run(["rev-parse", "--verify", "FETCH_HEAD^{commit}"]),
      "restore-head",
    );
    if (fetched !== head || (known !== null && !(await this.isAncestor(known, head)))) {
      throw new RelayError("GIT_UNRELATED_HISTORY", transportMessages.unrelated, 4);
    }
  }

  /**
   * Возвращает реальные Git counts без сети; неизвестные стороны остаются null.
   */
  async counts(): Promise<GitCounts> {
    const [local, remote] = await Promise.all([this.ref(this.localRef), this.ref(this.remoteRef)]);
    if (!local || !remote) {
      return { localHead: local, remoteHead: remote, ahead: null, behind: null };
    }
    if (local === remote) {
      return { localHead: local, remoteHead: remote, ahead: 0, behind: 0 };
    }
    if (this.directCounts?.localHead === local && this.directCounts.remoteHead === remote) {
      return this.directCounts;
    }
    const values = requireGit(
      await this.run(["rev-list", "--left-right", "--count", `${local}...${remote}`]),
      "counts",
    )
      .split(/\s+/)
      .map(Number);
    return {
      localHead: local,
      remoteHead: remote,
      ahead: values[0] ?? null,
      behind: values[1] ?? null,
    };
  }
}
