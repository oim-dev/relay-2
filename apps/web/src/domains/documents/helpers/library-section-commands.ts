import type { NamedCommand } from "@relay/contracts";
import type { LibrarySettings, DocumentSection } from "../types/document.type";

/**
 * Атомарный план изменения разделов под исходным CAS проекта, включая no-op
 * пустого каталога. Последующие guards ссылаются на ревизию предыдущего шага.
 */
export function librarySectionCommands(
  settings: LibrarySettings,
  sections: readonly DocumentSection[],
): NamedCommand[] {
  const changes: Array<{ op: string; input: Readonly<Record<string, unknown>> }> = [
    { op: "project.update", input: { name: settings.projectName } },
  ];
  for (const section of settings.sections) {
    if (!sections.some((next) => next.id === section.id))
      changes.push({ op: "document.section.remove", input: { id: section.id } });
  }
  for (const section of sections) {
    const previous = settings.sections.find((entry) => entry.id === section.id);
    if (!previous) changes.push({ op: "document.section.create", input: { ...section } });
    else if (previous.name !== section.name)
      changes.push({ op: "document.section.update", input: { ...section } });
  }
  if (sections.some((section, index) => settings.sections[index]?.id !== section.id)) {
    for (const section of sections)
      changes.push({ op: "document.section.move", input: { id: section.id, last: true } });
  }
  return changes.map((change, index) => ({
    ...change,
    as: `section${index}`,
    ifRevision: index === 0 ? settings.revision : { $revision: `section${index - 1}` },
  }));
}
