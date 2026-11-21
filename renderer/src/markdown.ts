import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

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

/**
 * Many Markdown notes start with "# <title>". The editor already shows the title
 * in its own field, so that first heading is hidden (but kept in the file) and
 * renamed along with the note.
 */
function firstHeading(editor: Editor) {
  const first = editor.state.doc.firstChild;
  return first && first.type.name === 'heading' && first.attrs.level === 1 ? first : null;
}

const norm = (s: string) => s.trim().toLowerCase();

export function titleHeadingMatches(editor: Editor, title: string): boolean {
  const heading = firstHeading(editor);
  return !!heading && !!title.trim() && norm(heading.textContent) === norm(title);
}

/** Rename the hidden "# title" heading when the title field changes. Returns true if it did. */
export function syncTitleHeading(editor: Editor, oldTitle: string, newTitle: string): boolean {
  if (!newTitle.trim() || !titleHeadingMatches(editor, oldTitle)) return false;
  const heading = firstHeading(editor)!;
  const { state, view } = editor;
  view.dispatch(state.tr.replaceWith(1, 1 + heading.content.size, state.schema.text(newTitle)));
  return true;
}

/** Keep the cursor out of the hidden heading (adds an empty paragraph if the note has nothing else). */
export function keepCaretOutOfTitleHeading(editor: Editor) {
  const heading = firstHeading(editor);
  if (!heading) return;
  const end = heading.nodeSize;
  const { state, view } = editor;
  if (state.selection.from >= end) return;
  let tr = state.tr;
  if (state.doc.childCount === 1) {
    tr = tr.insert(end, state.schema.nodes.paragraph.create());
  }
  const pos = Math.min(end + 1, tr.doc.content.size);
  tr = tr.setSelection(TextSelection.near(tr.doc.resolve(pos)));
  view.dispatch(tr);
}
