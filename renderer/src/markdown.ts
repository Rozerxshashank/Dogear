import type { Editor } from '@tiptap/core';

/**
 * Notes are stored as Markdown. Builds before this one saved the editor's HTML
 * into .md files, so detect that and load it as HTML; the next save rewrites
 * the file as Markdown.
 */
export function looksLikeLegacyHtml(content: string): boolean {
  const trimmed = content.trimStart();
  return /^<(p|h[1-6]|ul|ol|blockquote|pre|div|hr|table)[\s>/]/i.test(trimmed);
}

export function setNoteContent(editor: Editor, content: string) {
  const contentType = looksLikeLegacyHtml(content) ? 'html' : 'markdown';
  editor.commands.setContent(content || '', { contentType, emitUpdate: false } as any);
}

export function getNoteContent(editor: Editor): string {
  return (editor as any).getMarkdown() as string;
}
