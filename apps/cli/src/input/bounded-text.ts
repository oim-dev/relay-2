import { CliUsageError } from "../errors/errors";
import { argumentMessages } from "../locales/arguments";

/**
 * Собирает UTF-8 поток не более maxBytes байт, прекращая чтение при первом превышении.
 * Фрагменты строго декодируются вместе: неверный UTF-8 даёт INVALID_UTF8 без подстановки U+FFFD.
 * Границы чанков не повреждают многобайтовый Unicode; BOM и содержимое JSON сохраняются буквально.
 * При отказе for-await закрывает итератор источника; предметный JSON здесь не разбирается.
 */
export async function readBoundedText(
  source: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of source) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      throw new CliUsageError(argumentMessages.inputTooLarge(maxBytes), "INPUT_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks, bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
  } catch (cause) {
    throw new CliUsageError(argumentMessages.invalidUtf8, "INVALID_UTF8", { cause });
  }
}
