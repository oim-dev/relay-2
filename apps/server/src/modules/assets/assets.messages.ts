/**
 * Ошибки подготовки и упаковки готового Web.
 */
export const assetMessages = {
  missing: "Готовый Vite dist с index.html не найден; сначала соберите Web",
  symlink: "Символические ссылки не допускаются внутри упаковываемого Web",
  build: "Не удалось скомпилировать Relay Server",
  unused: "Сборка не подключила встроенный каталог Web",
} as const;
