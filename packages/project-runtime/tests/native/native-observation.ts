import { failureDiagnostic } from "./native-command";

/**
 * Удерживает отказ отдельного чтения в снимке, чтобы отсутствие журнала не скрыло task result.
 * Это диагностика отказа, а не assertion успешной уборки.
 */
export async function observe(
  label: string,
  read: () => unknown | Promise<unknown>,
): Promise<unknown> {
  try {
    return { label, value: await read() };
  } catch (error) {
    return { label, readError: failureDiagnostic(error) };
  }
}
