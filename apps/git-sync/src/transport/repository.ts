import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { RelayError } from "@relay/contracts";
import { checkGit, git, requireGit } from "./git";
import type { GitCounts, GitFiles, GitHistoryEntry, RepositoryOptions } from "./repository.types";
import type { ProcessInput, ProcessResult } from "./process.types";
import { transportMessages } from "./transport.messages";
import { selectSshProfile } from "./ssh-profile";
import type { SshProfile } from "./ssh-profile.types";
import { saveSshCapability } from "./ssh-state";
import { readGitObjects, readGitTrees } from "./git-objects";

const REMOTE_REF = "refs/relay/remote";
const LOCAL_REF = "refs/heads/data";
const ACCEPTED_REF = "refs/relay/accepted";
const MAX_TREE_BYTES = 128 * 1024 * 1024;

/**
 * Владеет Git-механикой: одна общая remote-ветка, отсутствие checkout и только FF push.
 * Вызывающий сериализует операции одного экземпляра; SQL и предметный merge сюда не входят.
 */
export class DataRepository {
  /* Параметры приватного репозитория и ограничений дочерних процессов. */
  readonly options: RepositoryOptions;
  /* Проверенный local ref этого владельца; undefined ещё не прочитан, null отсутствует. */
  private localHead: string | null | undefined;
  /* Проверенный remote ref этого владельца; обновляется только после validation. */
  private remoteHead: string | null | undefined;
  /* Точный Git commit после Core acceptance; отличается от fetched и неподтверждённого candidate. */
  private acceptedHead: string | null | undefined;
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
  }

  /**
   * Выполняет одну команду в принадлежащем проекту bare-репозитории.
   */
  private run(args: readonly string[], extra: Partial<ProcessInput> = {}): Promise<ProcessResult> {
    const signals = [this.options.signal, this.attemptSignal].filter(
      (signal): signal is AbortSignal => signal !== undefined && signal !== null,
    );
    return git(this.options.directory, args, {
      ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
      ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
      ...extra,
      env: {
        ...this.options.env,
        ...(this.sshProfile?.command ? { GIT_SSH_COMMAND: this.sshProfile.command } : {}),
        ...extra.env,
      },
    });
  }

  /**
   * Привязывает все последующие дочерние Git команды к живому attempt lease.
   */
  setAttemptSignal(signal: AbortSignal | null): void {
    this.attemptSignal = signal;
  }

  /**
   * Создаёт private bare repo или проверяет его origin; чужое подключение не заменяет.
   */
  async initialize(): Promise<void> {
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
   */
  private async verifyOrigin(): Promise<void> {
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
   * Читает локальный ref; отсутствие ref имеет отдельный ожидаемый exit code.
   */
  async ref(name: string): Promise<string | null> {
    let cached: string | null | undefined;
    if (name === LOCAL_REF) {
      cached = this.localHead;
    } else if (name === REMOTE_REF) {
      cached = this.remoteHead;
    } else if (name === ACCEPTED_REF) {
      cached = this.acceptedHead;
    }
    if (cached !== undefined) {
      return cached;
    }
    const result = await this.run(["rev-parse", "--verify", "--quiet", name]);
    const head = result.exitCode === 1 ? null : requireGit(result, "read-ref");
    if (name === LOCAL_REF) {
      this.localHead = head;
    }
    if (name === REMOTE_REF) {
      this.remoteHead = head;
    }
    if (name === ACCEPTED_REF) {
      this.acceptedHead = head;
    }
    return head;
  }

  /**
   * Получает только общую ветку без tags. Ошибка сети не трактуется как пустой remote.
   * Известная история может только продвигаться; rewind или удаление ветки дают явный отказ.
   */
  async fetch(): Promise<string | null> {
    await this.verifyOrigin();
    this.sshProfile = await selectSshProfile(
      { ...this.options, ...(this.attemptSignal ? { signal: this.attemptSignal } : {}) },
      this.defaultSshProfile,
    );
    if (this.sshProfile.capability.source === "default") {
      this.defaultSshProfile = this.sshProfile;
    }
    saveSshCapability(this.options.directory, this.sshProfile.capability);
    const known = await this.ref(REMOTE_REF);
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
    requireGit(await this.run(["update-ref", REMOTE_REF, head]), "remember-remote");
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
   * Одним fast-import записывает снимок на актуальный remote parent: веток реплик нет.
   * Совпадающее дерево возвращает parent без лишнего коммита. ID операций принадлежат Core.
   */
  async commit(files: GitFiles, parent: string | null): Promise<string> {
    // Предыдущий кандидат может быть отвергнут FF push; это только локальный временный ref.
    requireGit(await this.run(["update-ref", "-d", "refs/relay/prepared"]), "discard-prepared-ref");
    const chunks: (string | Uint8Array)[] = ["feature done\n"];
    const ordered = [...files].sort(([left], [right]) => left.localeCompare(right, "en"));
    for (const [index, [, bytes]] of ordered.entries()) {
      chunks.push(`blob\nmark :${index + 1}\ndata ${bytes.length}\n`, bytes, "\n");
    }
    const seconds = Math.floor(Date.now() / 1000);
    chunks.push(
      "reset refs/relay/prepared\n\ncommit refs/relay/prepared\n",
      `committer Relay Git Sync <relay@localhost> ${seconds} +0000\n`,
      "data 23\nRelay data snapshot v1\n\n",
    );
    if (parent) {
      chunks.push(`from ${parent}\n`);
    }
    chunks.push("deleteall\n");
    for (const [index, [path]] of ordered.entries()) {
      if (
        !/^[a-zA-Z0-9_./-]+$/.test(path) ||
        path.startsWith("/") ||
        path.split("/").some((part) => part === ".." || part === "." || !part)
      ) {
        throw new RelayError("GIT_INVALID_SNAPSHOT", transportMessages.invalidRepository, 4);
      }
      chunks.push(`M 100644 :${index + 1} ${path}\n`);
    }
    chunks.push("\ndone\n");
    requireGit(
      await this.run(["fast-import", "--quiet", "--done"], {
        input: Buffer.concat(
          chunks.map((chunk) =>
            typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk),
          ),
        ),
      }),
      "commit-snapshot",
    );
    let commit = requireGit(await this.run(["rev-parse", "refs/relay/prepared"]), "prepared-head");
    if (parent) {
      const trees = requireGit(
        await this.run(["rev-parse", `${parent}^{tree}`, `${commit}^{tree}`]),
        "compare-trees",
      ).split("\n");
      if (trees[0] === trees[1]) {
        commit = parent;
      }
    }
    requireGit(await this.run(["update-ref", LOCAL_REF, commit]), "local-head");
    this.localHead = commit;
    this.directCounts =
      parent !== null && this.remoteHead === parent
        ? { localHead: commit, remoteHead: parent, ahead: commit === parent ? 0 : 1, behind: 0 }
        : null;
    return commit;
  }

  /**
   * Публикует исключительно обычным FF push. Любой неуспех требует проверки remote вызывающим.
   */
  async push(commit: string): Promise<ProcessResult> {
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
   * Устанавливает принятый local head после подтверждённого применения в Core.
   */
  async accepted(head: string): Promise<void> {
    const updates: string[] = [];
    if (this.localHead !== head) {
      updates.push(`update ${LOCAL_REF} ${head}`);
    }
    if (this.remoteHead !== head) {
      updates.push(`update ${REMOTE_REF} ${head}`);
    }
    if (this.acceptedHead !== head) {
      updates.push(`update ${ACCEPTED_REF} ${head}`);
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
    return this.ref(ACCEPTED_REF);
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
    const known = await this.ref(REMOTE_REF);
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
    const [local, remote] = await Promise.all([this.ref(LOCAL_REF), this.ref(REMOTE_REF)]);
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
