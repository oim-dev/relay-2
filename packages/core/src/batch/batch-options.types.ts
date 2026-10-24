/**
 * Снимок адресных условий до первого await; проверка формы отложена до проверки receipt.
 */
export type CapturedCommandAddresses =
  { readonly kind: "captured"; readonly value: unknown } | { readonly kind: "uncloneable" };

/**
 * Зафиксированные параметры одного async исполнения, независимые от изменений caller object.
 */
export interface PreparedCommandOptions {
  /* Дословно проверенный автор исходного вызова. */
  readonly actor: string;
  /* Исходный ключ квитанции, null при отсутствии. */
  readonly operationKey: string | null;
  /* Исходный режим; caller не превращает выполняющийся check в apply. */
  readonly check: boolean;
  /* Копия адресных условий; replay не обязан проверять её предметную форму. */
  readonly addresses: CapturedCommandAddresses;
}
