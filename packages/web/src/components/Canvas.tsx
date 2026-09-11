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
  const theme = useStore((s) => s.theme);

  const onPaneClick = useCallback(() => select(null), [select]);

  return (
    <div className="canvas-wrap">
      {nodes.length === 0 && (
        <div className="canvas-empty">
          <div className="big">画布还是空的</div>
          <div className="steps">
            ① 顶栏设置流水线工作目录　② 从左侧点击添加「开始 → Agent → 结束」节点<br />
            ③ 从节点右侧圆点拖线连接　④ 点「? 指南」看完整教程
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
