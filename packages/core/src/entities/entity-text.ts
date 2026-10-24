/**
 * Проверяет представимость управляющего адресного текста в UTF-8 без замены lone surrogate.
 * Реализация совместима с ES2022 потребителей; исходная строка и корректные пары не меняются.
 */
export function isWellFormedAddressText(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return false;
    }
  }
  return true;
}
