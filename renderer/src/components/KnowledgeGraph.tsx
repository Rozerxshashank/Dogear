import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useNotesStore } from '../store/notesStore';
import { apiUrl } from '../api';
// @ts-expect-error d3-force-3d ships without type definitions
import { forceCollide, forceX, forceY } from 'd3-force-3d';


interface GraphNode {
  id: string;
  label: string;
  val: number;
}

interface GraphEdge {
  source: string;
  target: string;
  link_type: string;
  value: number;
}

export const KnowledgeGraph: React.FC = () => {
  const [graphData, setGraphData] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] }>({ nodes: [], edges: [] });
  const ipcToken = useNotesStore((s) => s.ipcToken);
  const setActiveNote = useNotesStore((s) => s.setActiveNote);
  const graphRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [ForceGraph, setForceGraph] = useState<any>(null);
  const [hoverNode, setHoverNode] = useState<GraphNode | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // Refetch when notes are added, renamed or edited (links come from note content)
  const notesSignature = useNotesStore((s) => s.notes.map((n) => `${n.id}:${n.updated_at}`).join('|'));

  // Canvas can't read CSS variables, so resolve the theme colours once per render
  const css = getComputedStyle(document.documentElement);
  const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const accent = color('--color-accent', '#52b788');
  const border = color('--color-border', '#d9d9de');
  const textPrimary = color('--color-text-primary', '#1d1d1f');
  const textSecondary = color('--color-text-secondary', '#8e8e93');
  const background = color('--color-bg-main', '#ffffff');

  // Track the panel size so the canvas never overflows it
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [ForceGraph, graphData.nodes.length > 0]);

  // Dynamically import react-force-graph-2d (it uses canvas, needs browser env)
  useEffect(() => {
    import('react-force-graph-2d').then((mod) => {
      setForceGraph(() => mod.default);
    });
  }, []);

  useEffect(() => {
    if (!ipcToken) return;
    fetch(`${apiUrl('/graph')}/`, {
      headers: { 'X-IPC-Token': ipcToken }
    })
      .then((r) => r.json())
      .then((data) => {
        setGraphData({
          nodes: data.nodes,
          edges: data.edges.map((e: GraphEdge) => ({ ...e, source: e.source, target: e.target }))
        });
      })
      .catch(console.error);
  }, [ipcToken, notesSignature]);

  // Spread unconnected notes apart and keep linked ones at a readable distance
  useEffect(() => {
    const fg = graphRef.current;
    if (!fg || graphData.nodes.length === 0) return;
    // Gentle repulsion keeps unrelated notes nearby instead of flinging them to the edges;
    // the collision radius leaves room for each label so names never overlap.
    fg.d3Force('charge')?.strength(-30).distanceMax(160);
    fg.d3Force('link')?.distance(80).strength(0.6);
    fg.d3Force('collide', forceCollide(46).strength(1));
    // The side panel is tall and narrow: pull nodes in sideways more than vertically
    // so the layout fills the panel and stays legible after fitting.
    const aspect = size.width && size.height ? size.height / size.width : 1;
    fg.d3Force('x', forceX(0).strength(0.12));
    fg.d3Force('y', forceY(0).strength(0.12 / Math.max(1, aspect)));
    fg.d3ReheatSimulation?.();
    // Frame everything once the layout has mostly settled
    const timer = setTimeout(() => fg.zoomToFit?.(400, 48), 1800);
    return () => clearTimeout(timer);
  }, [graphData, ForceGraph, size.width > 0]);

  // Re-frame when the panel is resized
  useEffect(() => {
    if (size.width && size.height) graphRef.current?.zoomToFit?.(200, 48);
  }, [size.width, size.height]);

  const handleNodeClick = useCallback((node: any) => {
    setActiveNote(node.id);
  }, [setActiveNote]);

  if (!ForceGraph) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--color-text-secondary)' }}>
        Loading graph...
      </div>
    );
  }

  if (graphData.nodes.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-small)' }}>
        No notes to visualize yet
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%' }}>
      <ForceGraph
        ref={graphRef}
        graphData={{ nodes: graphData.nodes, links: graphData.edges }}
        nodeLabel={() => ''}
        nodeVal="val"
        linkColor={(link: any) => {
          if (!hoverNode) return textSecondary;
          return link.source.id === hoverNode.id || link.target.id === hoverNode.id
            ? accent
            : 'rgba(150, 150, 150, 0.12)';
        }}
        linkLineDash={(link: any) => (link.link_type === 'auto' ? [3, 3] : null)}
        linkWidth={(link: any) => {
          if (hoverNode && (link.source.id === hoverNode.id || link.target.id === hoverNode.id)) return 3;
          return link.link_type === 'manual' ? 1.5 : 1;
        }}
        linkDirectionalParticles={(link: any) => {
          if (hoverNode && (link.source.id === hoverNode.id || link.target.id === hoverNode.id)) return 4;
          return 0;
        }}
        linkDirectionalParticleSpeed={0.005}
        nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
          const label = node.label;
          const fontSize = 11 / globalScale;
          // Dots stay a readable size on screen at any zoom; longer notes are slightly bigger
          const size = Math.min(7, 4 + Math.sqrt(node.val || 1) * 0.8) / Math.max(globalScale, 0.6);

          const accentColor = accent;
          const textColor = textPrimary;
          const bgColor = background;
          const dimColor = border;
          const isHovered = hoverNode?.id === node.id;
          const isNeighbor = hoverNode ? graphData.edges.some((e: any) => 
            (e.source.id === hoverNode.id && e.target.id === node.id) || 
            (e.target.id === hoverNode.id && e.source.id === node.id)
          ) : false;

          let nodeColor = accentColor;
          if (hoverNode && !isHovered && !isNeighbor) {
            nodeColor = dimColor;
          }

          if (isHovered) {
            ctx.beginPath();
            ctx.arc(node.x, node.y, size + 4/globalScale, 0, 2 * Math.PI, false);
            ctx.globalAlpha = 0.2;
            ctx.fillStyle = accentColor;
            ctx.fill();
            ctx.globalAlpha = 1;
          }

          ctx.beginPath();
          ctx.arc(node.x, node.y, size, 0, 2 * Math.PI, false);
          ctx.fillStyle = nodeColor;
          ctx.fill();
          
          ctx.lineWidth = (isHovered ? 2.5 : 1.5) / globalScale;
          ctx.strokeStyle = bgColor;
          ctx.stroke();

          const currentTextColor = hoverNode && !isHovered && !isNeighbor ? textSecondary : textColor;
          ctx.font = `${isHovered ? 'bold ' : ''}${fontSize}px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = currentTextColor;
          
          const labelYOffset = size + (isHovered ? 8/globalScale : 4/globalScale) + fontSize/2;
          ctx.fillText(label, node.x, node.y + labelYOffset);
        }}
        onNodeClick={handleNodeClick}
        onNodeHover={(node: any) => setHoverNode(node || null)}
        d3AlphaDecay={0.02}
        d3VelocityDecay={0.3}
        cooldownTime={2500}
        onEngineStop={() => graphRef.current?.zoomToFit(300, 48)}
        width={size.width || 300}
        height={size.height || 300}
        backgroundColor="transparent"
      />
    </div>
  );
};
