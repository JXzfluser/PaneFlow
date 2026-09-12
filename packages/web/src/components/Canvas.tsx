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
import { AgentNode, StartNode, EndNode, FanoutNode, FaninNode, PipelineNode } from './nodes.jsx';

const nodeTypes: NodeTypes = {
  start: StartNode,
  end: EndNode,
  agent: AgentNode,
  fanout: FanoutNode,
  fanin: FaninNode,
  pipeline: PipelineNode,
};

export function Canvas() {
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const onNodesChange = useStore((s) => s.onNodesChange);
  const onEdgesChange = useStore((s) => s.onEdgesChange);
  const onConnect = useStore((s) => s.onConnect);
  const select = useStore((s) => s.select);
  const selectEdge = useStore((s) => s.selectEdge);
  const theme = useStore((s) => s.theme);
  const setView = useStore((s) => s.setView);
  const scaffoldStarter = useStore((s) => s.scaffoldStarter);

  const onPaneClick = useCallback(() => select(null), [select]);

  return (
    <div className="canvas-wrap">
      {nodes.length === 0 && (
        <div className="canvas-empty">
          <div className="big">这块画布还是空的</div>
          <div className="steps">
            先想清楚「要做什么」，不用先学会画图。
          </div>
          <div className="empty-actions">
            <button className="primary" onClick={() => setView('tasks')}>
              ✎ 描述需求，自动编排
            </button>
            <button onClick={scaffoldStarter}>⚙ 一键搭好骨架</button>
          </div>
          <div className="steps hint">
            从左侧「模板」载入骨架也行；想改结构就在这儿拖拽连线，完整教程在右上角「? 指南」。
          </div>
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, n) => select(n.id)}
        onEdgeClick={(_, e) => selectEdge(e.id)}
        onPaneClick={onPaneClick}
        fitView
        deleteKeyCode={['Backspace', 'Delete']}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color={theme === 'light' ? '#ddd6c4' : '#373227'} />
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
