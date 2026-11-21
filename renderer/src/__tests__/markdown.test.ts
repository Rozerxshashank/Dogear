import { describe, expect, test } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { WikilinkExtension } from '../components/WikilinkExtension';
import { getNoteContent, keepCaretOutOfTitleHeading, looksLikeLegacyHtml, setNoteContent, syncTitleHeading, titleHeadingMatches } from '../markdown';

function makeEditor() {
  return new Editor({ extensions: [StarterKit, Markdown, WikilinkExtension] });
}

describe('note markdown round-trip', () => {
  test('standard markdown survives load and save', () => {
    const editor = makeEditor();
    const md = '# Title\n\nSome **bold** and *italic* and [a link](https://example.com)\n\n- one\n- two\n\n```js\nconst a = 1;\n```';
    setNoteContent(editor, md);
    expect(getNoteContent(editor).trim()).toBe(md);
  });

  test('wikilinks are kept exactly, including aliases and headings', () => {
    const editor = makeEditor();
    const md = 'See [[Project Plan]] and [[Meeting Notes#Actions|the actions]].';
    setNoteContent(editor, md);
    expect(getNoteContent(editor).trim()).toBe(md);
    expect(editor.getJSON().content?.[0].content?.some((n: any) => n.type === 'wikilink')).toBe(true);
  });

  test('legacy HTML notes are converted to markdown', () => {
    const editor = makeEditor();
    const html = '<h1>Old</h1><p>html <strong>note</strong></p>';
    expect(looksLikeLegacyHtml(html)).toBe(true);
    setNoteContent(editor, html);
    expect(getNoteContent(editor).trim()).toBe('# Old\n\nhtml **note**');
  });

  test('markdown that starts with inline html-ish text is not treated as legacy', () => {
    expect(looksLikeLegacyHtml('# Heading\n\n<p>inline</p>')).toBe(false);
    expect(looksLikeLegacyHtml('<kbd>Ctrl</kbd> + C')).toBe(false);
  });
});

describe('title shown once', () => {
  test('a leading "# title" heading is detected (case-insensitive)', () => {
    const editor = makeEditor();
    setNoteContent(editor, '# Q3 Planning\n\nGoal for the quarter.');
    expect(titleHeadingMatches(editor, 'q3 planning')).toBe(true);
    expect(titleHeadingMatches(editor, 'Something else')).toBe(false);
  });

  test('notes without a matching heading are left alone', () => {
    const editor = makeEditor();
    setNoteContent(editor, 'Just text, no heading.');
    expect(titleHeadingMatches(editor, 'Anything')).toBe(false);
    expect(syncTitleHeading(editor, 'Anything', 'New')).toBe(false);
  });

  test('renaming the note renames the hidden heading in the file', () => {
    const editor = makeEditor();
    setNoteContent(editor, '# Old name\n\nBody stays.');
    expect(syncTitleHeading(editor, 'Old name', 'New name')).toBe(true);
    expect(getNoteContent(editor).trim()).toBe('# New name\n\nBody stays.');
  });

  test('the cursor is moved out of the hidden heading', () => {
    const editor = makeEditor();
    setNoteContent(editor, '# Only a title');
    editor.commands.setTextSelection(2);
    keepCaretOutOfTitleHeading(editor);
    const heading = editor.state.doc.firstChild!;
    expect(editor.state.selection.from).toBeGreaterThanOrEqual(heading.nodeSize);
    expect(editor.state.doc.childCount).toBe(2); // an empty paragraph was added to type into
  });
});
