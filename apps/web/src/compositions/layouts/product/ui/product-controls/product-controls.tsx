import { useState } from "react";
import { Alert, Button, Group, Modal, NativeSelect, Text } from "@mantine/core";
import { RotateCcw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { DEMO_MODE_OPTIONS, DEMO_MODE_SCHEMA, useProductDemo } from "domains/product-demo";
import { useProductPath } from "compositions/widgets/product-page";
import styles from "./styles/product-controls.module.css";

/**
 * Предоставляет состояния моковых данных и явное восстановление исходного продукта.
 *
 * Используется для:
 *  - проверки прототипа в существующем разделе проекта
 */
export const ProductControls = () => {
  const { mode, notice, setMode, reset } = useProductDemo();
  const [isResetOpen, setResetOpen] = useState(false);
  const navigate = useNavigate();
  const base = useProductPath();
  const hasNotice = notice !== "";
  /**
   * Открывает подходящий подраздел для наблюдения выбранного состояния.
   */
  const handleModeChange = (selection: string): void => {
    const parsed = DEMO_MODE_SCHEMA.safeParse(selection);
    if (!parsed.success) return;
    if (parsed.data === "no-results") setMode("filled");
    setMode(parsed.data);
    if (parsed.data === "no-results") navigate(`${base}/features?q=несуществующая+фича`);
    if (parsed.data === "empty") navigate(`${base}/passport`);
    if (parsed.data === "filled" && mode === "no-results") navigate(`${base}/features`);
  };
  /**
   * Сбрасывает локальные правки после подтверждения.
   */
  const handleReset = (): void => {
    reset();
    setResetOpen(false);
    navigate(`${base}/passport`);
  };
  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <Text size="xs" c="dimmed">
          Прототип · изменения сохраняются только в этой вкладке
        </Text>
        <div className={styles.actions}>
          <NativeSelect
            aria-label="Состояние прототипа"
            size="xs"
            value={mode}
            data={DEMO_MODE_OPTIONS}
            onChange={(event) => handleModeChange(event.currentTarget.value)}
          />
          <Button
            size="xs"
            color="gray"
            variant="subtle"
            leftSection={<RotateCcw size={13} aria-hidden="true" />}
            onClick={() => setResetOpen(true)}
          >
            Сбросить
          </Button>
        </div>
      </div>
      {hasNotice && (
        <Alert color="gray" role="status" radius={0}>
          {notice}
        </Alert>
      )}
      <Modal
        opened={isResetOpen}
        onClose={() => setResetOpen(false)}
        closeButtonProps={{ "aria-label": "Отменить сброс" }}
        title="Восстановить исходные данные?"
        centered
      >
        <Text size="sm">
          Вернётся исходный пример «Напрокат». Локальные правки и черновики раздела будут сброшены.
        </Text>
        <Group mt="lg" justify="flex-end">
          <Button variant="default" onClick={() => setResetOpen(false)}>
            Отмена
          </Button>
          <Button onClick={handleReset}>Восстановить</Button>
        </Group>
      </Modal>
    </div>
  );
};
