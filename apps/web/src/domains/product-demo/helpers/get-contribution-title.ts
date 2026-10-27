/**
 * Дополняет прежний вклад коротким заголовком, сохраняя исходный Markdown целиком.
 */
export const getContributionTitle = (description: string): string => {
  const line =
    description
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry !== "" && !/^#{1,6}\s/.test(entry)) ?? "";
  const plain = line
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^[>\-*+]\s*/, "")
    .replace(/[*_`~]/g, "");
  const title = plain.split(/[.!?](?:\s|$)/)[0]?.trim() ?? "";
  if (title.length <= 140) return title;
  return `${title
    .slice(0, 137)
    .replace(/\s+\S*$/, "")
    .trim()}…`;
};
