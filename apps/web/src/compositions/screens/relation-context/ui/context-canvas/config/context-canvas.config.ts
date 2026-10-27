/** Геометрия карточки для ELK и React Flow без повторного измерения. */
export const CONTEXT_NODE_SIZE = { width: 300, height: 176 };

/** Русские инструкции встроенного клавиатурного управления React Flow. */
export const CONTEXT_ARIA_LABELS = {
  "node.a11yDescription.default":
    "Нажмите Enter или пробел, чтобы выбрать сущность. Стрелки перемещают карточку только на диаграмме.",
  "node.a11yDescription.keyboardDisabled": "Нажмите Enter или пробел, чтобы выбрать сущность.",
  "edge.a11yDescription.default": "Нажмите Enter или пробел, чтобы прочитать связь.",
  "controls.zoomIn.ariaLabel": "Увеличить масштаб",
  "controls.zoomOut.ariaLabel": "Уменьшить масштаб",
  "controls.fitView.ariaLabel": "Вписать в экран",
  "controls.interactive.ariaLabel": "Переключить перемещение карточек",
  "minimap.ariaLabel": "Мини-карта контекста",
  "handle.ariaLabel": "Конец сохранённой связи",
};
