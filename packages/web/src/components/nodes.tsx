import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { PfNodeData } from '../store.js';

const STATE_LABEL: Record<string, string> = {
  pending: '等待',
  queued: '排队',
  starting: '启动中',
  working: '运行中',
  blocked: '待审批',
  paused: '审批暂停',
  retrying: '重试中',
  done: '完成',
  failed: '失败',
  skipped: '跳过',
  cancelled: '已取消',
};

export function AgentNode({ data, selected }: NodeProps & { data: PfNodeData }) {
  const d = data as PfNodeData;
  const runState = d.runState;
  const badgeClass = runState
    ? runState === 'done'
      ? 'badge done'
      : runState === 'blocked'
        ? 'badge blocked'
        : runState === 'failed'
          ? 'badge failed'
          : runState === 'working' || runState === 'starting' || runState === 'retrying'
            ? 'badge working'
            : 'badge'
    : 'badge';
  const statusColor =
    d.agentStatus === 'blocked'
      ? 'var(--err)'
      : d.agentStatus === 'working'
        ? 'var(--warn)'
        : d.agentStatus === 'done'
          ? 'var(--ok)'
          : d.agentStatus === 'idle'
            ? 'var(--idle)'
            : 'transparent';
  return (
    <div className={`pf-node type-agent ${selected ? 'selected' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="head">
        ⚙ {d.dagNode.label}
        {runState && <span className={badgeClass}>{STATE_LABEL[runState] ?? runState}</span>}
      </div>
      <div className="body">
        {d.dagNode.config.agentKind ?? '未配置'}
        {d.dagNode.config.cwd ? ` · ${d.dagNode.config.cwd}` : ''}
      </div>
      <div className="statusbar" style={{ background: statusColor }} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function StartNode({ data, selected }: NodeProps & { data: PfNodeData }) {
  const d = data as PfNodeData;
  return (
    <div className={`pf-node type-start ${selected ? 'selected' : ''}`} style={{ minWidth: 120 }}>
      <Handle type="source" position={Position.Right} />
      <div className="head">▶ {d.dagNode.label}</div>
    </div>
  );
}

export function EndNode({ data, selected }: NodeProps & { data: PfNodeData }) {
  const d = data as PfNodeData;
  return (
    <div className={`pf-node type-end ${selected ? 'selected' : ''}`} style={{ minWidth: 120 }}>
      <Handle type="target" position={Position.Left} />
      <div className="head">■ {d.dagNode.label}</div>
    </div>
  );
}

export function FanoutNode({ data, selected }: NodeProps & { data: PfNodeData }) {
  const d = data as PfNodeData;
  return (
    <div className={`pf-node ${selected ? 'selected' : ''}`} style={{ minWidth: 120 }}>
      <Handle type="target" position={Position.Left} />
      <div className="head">⑂ {d.dagNode.label}</div>
      <div className="body">分支并行启动</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function PipelineNode({ data, selected }: NodeProps & { data: PfNodeData }) {
  const d = data as PfNodeData;
  const tpl = d.dagNode.config.pipeline?.template ?? '未配置模板';
  const mode = d.dagNode.config.pipeline?.mode === 'fire' ? '即发即忘' : '等待完成';
  return (
    <div className={`pf-node ${selected ? 'selected' : ''}`} style={{ minWidth: 150 }}>
      <Handle type="target" position={Position.Left} />
      <div className="head">⇢ {d.dagNode.label}</div>
      <div className="body">⇒ {tpl.length > 22 ? tpl.slice(0, 22) + '…' : tpl} · {mode}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function FaninNode({ data, selected }: NodeProps & { data: PfNodeData }) {
  const d = data as PfNodeData;
  return (
    <div className={`pf-node ${selected ? 'selected' : ''}`} style={{ minWidth: 120 }}>
      <Handle type="target" position={Position.Left} />
      <div className="head">⑀ {d.dagNode.label}</div>
      <div className="body">{d.dagNode.config.requireAll === false ? '宽容汇聚' : '严格汇聚'}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
