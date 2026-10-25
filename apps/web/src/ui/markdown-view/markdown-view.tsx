import clsx from "clsx";
import ReactMarkdown from "react-markdown";
import type { Options } from "react-markdown";
import type { ReactElement } from "react";
import remarkGfm from "remark-gfm";
import { MarkdownLink } from "ui/markdown-link";
import { MarkdownCheckbox } from "./ui/markdown-checkbox/markdown-checkbox";
import { getHeadingTags } from "./helpers/get-heading-tags";
import { remarkHeadingHierarchy } from "./helpers/remark-heading-hierarchy";
import { rehypeFocusableBlocks } from "./helpers/rehype-focusable-blocks";
import type { MarkdownViewProps } from "./types/markdown-view-props.type";
import styles from "./styles/markdown-view.module.css";
import { markdownViewMessages } from "./markdown-view.messages";

/**
 * Отображает требования, результаты и обсуждения в читаемой типографике.
 *
 * Используется для:
 *  - безопасного просмотра Markdown со списками, кодом и таблицами
 */
export const MarkdownView = (props: MarkdownViewProps): ReactElement => {
  const {
    text,
    compact = false,
    emptyText = markdownViewMessages.empty,
    headingOffset = 0,
    headingStartLevel,
    focusableBlocks = false,
    className,
    ...rootAttrs
  } = props;
  const rootClassName = clsx(styles.root, compact && styles._compact, className);
  const remarkPlugins: NonNullable<Options["remarkPlugins"]> = [remarkGfm];
  const rehypePlugins: NonNullable<Options["rehypePlugins"]> = focusableBlocks
    ? [rehypeFocusableBlocks]
    : [];
  if (headingStartLevel !== undefined) {
    remarkPlugins.push([remarkHeadingHierarchy, headingStartLevel]);
  }
  const effectiveOffset = headingStartLevel === undefined ? headingOffset : 0;
  if (text.trim() === "") {
    return (
      <div {...rootAttrs} className={clsx(rootClassName, styles._empty)}>
        {emptyText}
      </div>
    );
  }
  return (
    <div {...rootAttrs} className={rootClassName}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={{
          input: MarkdownCheckbox,
          a: MarkdownLink,
          ...getHeadingTags(effectiveOffset),
        }}
        skipHtml
      >
        {text}
      </ReactMarkdown>
    </div>
  );
};
