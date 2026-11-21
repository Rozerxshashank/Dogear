import React from 'react';
import { Node, mergeAttributes, nodeInputRule } from '@tiptap/core';
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import { useNotesStore } from '../store/notesStore';

const WIKILINK_SOURCE = /^\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|([^\]\n]+))?\]\]/;

/**
 * [[Target]] / [[Target|alias]] links. Stored in the .md file exactly as typed
 * (Obsidian-compatible), shown as a styled chip in the editor.
 */
export const WikilinkExtension = Node.create({
  name: 'wikilink',
  group: 'inline',
  inline: true,
  selectable: true,
  atom: true,

  addAttributes() {
    return {
      target: { default: null },
      label: { default: null },
      raw: { default: null }, // original source, so aliases/headings round-trip exactly
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="wikilink"]' }];
  },

  renderHTML({ node, HTMLAttributes }: any) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-type': 'wikilink', class: 'wikilink' }), `[[${node.attrs.label ?? node.attrs.target}]]`];
  },

  // --- Markdown (used by @tiptap/markdown) ---
  markdownTokenizer: {
    name: 'wikilink',
    level: 'inline',
    start: (src: string) => src.indexOf('[['),
    tokenize: (src: string) => {
      const match = WIKILINK_SOURCE.exec(src);
      if (!match) return undefined;
      return { type: 'wikilink', raw: match[0], target: match[1].trim(), label: (match[2] || match[1]).trim() };
    },
  },

  parseMarkdown: (token: any) => ({
    type: 'wikilink',
    attrs: { target: token.target, label: token.label, raw: token.raw },
  }),

  renderMarkdown: (node: any) => node.attrs.raw || `[[${node.attrs.target ?? node.attrs.label}]]`,

  addInputRules() {
    return [
      nodeInputRule({
        find: /\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]$/,
        type: this.type,
        getAttributes: (match) => ({
          target: match[1].trim(),
          label: (match[2] || match[1]).trim(),
          raw: match[0],
        }),
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(WikilinkNodeView);
  },
} as any);

const WikilinkNodeView = (props: any) => {
  const target: string = props.node.attrs.target ?? props.node.attrs.label ?? '';
  const exists = useNotesStore((s) => s.notes.some((n) => n.title.trim().toLowerCase() === target.trim().toLowerCase()));
  const open = () => { void useNotesStore.getState().openNoteByTitle(target); };
  return (
    <NodeViewWrapper
      as="span"
      className="wikilink"
      role="link"
      tabIndex={0}
      title={exists ? `Open "${target}"` : `Create "${target}"`}
      onClick={open}
      onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter') open(); }}
      style={{
        color: 'var(--color-accent)',
        cursor: 'pointer',
        textDecoration: 'underline',
        textDecorationStyle: exists ? 'solid' : 'dashed',
        opacity: exists ? 1 : 0.75,
      }}
    >
      [[{props.node.attrs.label ?? target}]]
    </NodeViewWrapper>
  );
};
