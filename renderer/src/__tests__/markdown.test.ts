import { describe, expect, test } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { WikilinkExtension } from '../components/WikilinkExtension';
import { getNoteContent, looksLikeLegacyHtml, setNoteContent } from '../markdown';

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
