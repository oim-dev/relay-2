import { readOutputMessages as messages } from "../locales/reads";
import { outputMessages } from "../locales/output";
import { isObject, renderFullValue } from "./values";
import { terminalText } from "./terminal";

/**
 * Представляет только поля краткой проекции Core; полное содержание здесь не запрашивается.
 */
function renderReadSummary(entity: Readonly<Record<string, unknown>>): string {
  const summary = outputMessages.entity(
    messages.identity(String(entity.key), String(entity.kind), String(entity.id)),
    String(entity.title).replace(/\s+/g, " "),
    String(entity.revision),
    entity.state === undefined ? undefined : String(entity.state),
  );
  return entity.active === false
    ? outputMessages.summary([summary, outputMessages.inactiveImplementation])
    : summary;
}

/**
 * Выбирает заголовок по общему индексу очищенных строк всего набора без повторного сканирования.
 * Кандидаты различаются номером элемента; каждый отклонённый заголовок соответствует строке ввода.
 * Адрес кодируется как JSON-строка, поэтому переводы строк не могут подделать заголовок.
 */
function renderReadHeader(index: number, ref: string, lines: ReadonlySet<string>): string {
  const address = JSON.stringify(terminalText(ref));
  let fence = "===";
  let suffix = 0;
  let header = messages.begin(fence, index, address);
  while (lines.has(header)) {
    fence = `===${++suffix}`;
    header = messages.begin(fence, index, address);
  }
  return header;
}

/**
 * Форматирует найденную запись или ошибку на её исходном месте, сохраняя полное содержание.
 */
function renderReadContent(item: Readonly<Record<string, unknown>>, summary: boolean): string {
  if (item.ok === false && isObject(item.error)) {
    const failure = messages.failure(String(item.error.code), String(item.error.message));
    return item.error.details === undefined
      ? failure
      : `${failure}\n${renderFullValue(item.error.details)}`;
  }
  if (summary && isObject(item.entity)) {
    return renderReadSummary(item.entity);
  }
  return renderFullValue(item.entity);
}

/**
 * Форматирует полный либо краткий адресный набор без повторного чтения и без скрытия ошибок.
 * Проверяется только оболочка для представления; предметные данные уже проверены Core.
 * Содержание всех элементов очищается до выбора заголовков; общий индекс строится за один проход.
 * Суммарная стоимость линейна по содержанию и заголовкам, включая межэлементные коллизии.
 */
export function renderEntityRead(data: unknown): string {
  if (!isObject(data) || !Array.isArray(data.items)) {
    return renderFullValue(data);
  }
  const items = data.items.map((item: unknown) => {
    if (!isObject(item) || typeof item.ref !== "string") {
      return { ref: undefined, content: terminalText(renderFullValue(item)) };
    }
    return {
      ref: item.ref,
      content: terminalText(renderReadContent(item, data.view === "summary")),
    };
  });
  const lines = new Set<string>();
  for (const item of items) {
    for (const line of item.content.split("\n")) {
      lines.add(line);
    }
  }
  return items
    .map((item, index) => {
      if (item.ref === undefined) {
        return item.content;
      }
      return `${renderReadHeader(index + 1, item.ref, lines)}\n${item.content}`;
    })
    .join("\n\n");
}
