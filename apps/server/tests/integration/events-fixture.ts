/**
 * Читает один SSE кадр, сохраняя остальные кадры того же chunk; deadline задаёт исходный fetch.
 * Reader принадлежит вызывающему тесту, который обязан отменить его при любом исходе.
 */
export function events(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): () => Promise<Record<string, unknown>> {
  let buffer = "";
  const decoder = new TextDecoder();
  return async () => {
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        const value: unknown = JSON.parse(data?.slice(6) ?? "null");
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("Некорректный SSE кадр");
        }
        // Проверена форма JSON объекта; значения отдельных полей проверяет сценарий.
        return value as Record<string, unknown>;
      }
      const chunk = await reader.read();
      if (chunk.done) {
        throw new Error("SSE завершился до ожидаемого события");
      }
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };
}
