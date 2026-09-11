import { useCallback } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useStore, type PfNodeData } from '../store.js';
import { AgentNode, StartNode, EndNode, FanoutNode, FaninNode } from './nodes.jsx';

const nodeTypes: NodeTypes = {
  start: StartNode,
  end: EndNode,
  agent: AgentNode,
  fanout: FanoutNode,
  fanin: FaninNode,
};

export function Canvas() {
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const onNodesChange = useStore((s) => s.onNodesChange);
  const onEdgesChange = useStore((s) => s.onEdgesChange);
  const onConnect = useStore((s) => s.onConnect);
  const select = useStore((s) => s.select);

  const onPaneClick = useCallback(() => select(null), [select]);

  return (
    <div className="canvas-wrap">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, n) => select(n.id)}
        onPaneClick={onPaneClick}
        fitView
        deleteKeyCode={['Backspace', 'Delete']}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#1d2430" />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => {
            const st = (n.data as PfNodeData).runState;
            if (st === 'blocked' || st === 'failed') return '#f85149';
            if (st === 'done') return '#3fb950';
            if (st === 'working' || st === 'starting') return '#d29922';
            return '#232a36';
          }}
        />
      </ReactFlow>
    </div>
  );
}
