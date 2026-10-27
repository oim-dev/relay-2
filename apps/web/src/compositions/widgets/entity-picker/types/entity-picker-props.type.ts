import type { SelectProps } from "@mantine/core";

/** Поле выбора произвольной сущности с серверным поиском и продолжением. */
export type EntityPickerProps = Pick<
  SelectProps,
  | "label"
  | "placeholder"
  | "defaultValue"
  | "value"
  | "onChange"
  | "onBlur"
  | "error"
  | "disabled"
  | "required"
> & {
  /** Проект, в котором выбирается сущность. */
  projectId: string;
};
