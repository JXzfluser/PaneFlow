import { useStore } from '../store.js';

export function PropertyPanel() {
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const nodes = useStore((s) => s.nodes);
  const updateNodeConfig = useStore((s) => s.updateNodeConfig);
  const agentKinds = useStore((s) => s.agentKinds);

  const node = nodes.find((n) => n.id === selectedNodeId);
  if (!node) {
    return (
      <div className="props">
        <h3>属性</h3>
        <div className="hint">点击画布中的节点进行配置。Agent 节点必须配置 Agent 类型和任务指令。</div>
      </div>
    );
  }
  const cfg = node.data.dagNode.config;
  const isAgent = node.data.dagNode.type === 'agent';
  const isFanin = node.data.dagNode.type === 'fanin';
  const set = (patch: Parameters<typeof updateNodeConfig>[1]) => updateNodeConfig(node.id, patch);

  return (
    <div className="props">
      <h3>属性 · {node.data.dagNode.label}</h3>
      <label>节点名称</label>
      <input
        value={node.data.dagNode.label}
        onChange={(e) => {
          const label = e.target.value;
          updateNodeConfig(node.id, {});
          // label lives on dagNode; reuse config patch channel via store
          useStore.setState((s) => ({
            nodes: s.nodes.map((n) =>
              n.id === node.id ? { ...n, data: { ...n.data, dagNode: { ...n.data.dagNode, label } } } : n,
            ),
          }));
        }}
      />

      {isAgent && (
        <>
          <label>Agent 类型（herdr kind）</label>
          <select value={cfg.agentKind ?? ''} onChange={(e) => set({ agentKind: e.target.value })}>
            <option value="" disabled>选择…</option>
            {agentKinds.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>

          <label>任务指令（prompt）</label>
          <textarea
            placeholder={'要完成的任务。可引用上游产物：{{nodeId.artifact.summary}} 或 {{nodeId.output}}'}
            value={cfg.prompt ?? ''}
            onChange={(e) => set({ prompt: e.target.value })}
          />
          <div className="hint">系统会自动附加「结果写入 .herdr/artifact.json」的交接约定。</div>

          <div className="row">
            <div>
              <label>重试次数</label>
              <input
                type="number" min={0} max={5} value={cfg.retryCount ?? 0}
                onChange={(e) => set({ retryCount: Math.max(0, Number(e.target.value) || 0) })}
              />
            </div>
            <div>
              <label>超时（分钟，0=默认15）</label>
              <input
                type="number" min={0} max={240} value={cfg.timeoutMs ? Math.round(cfg.timeoutMs / 60000) : 0}
                onChange={(e) => set({ timeoutMs: (Number(e.target.value) || 0) * 60000 })}
              />
            </div>
          </div>

          <label>失败策略</label>
          <select value={cfg.onFail ?? 'abort'} onChange={(e) => set({ onFail: e.target.value as 'abort' | 'continue' })}>
            <option value="abort">终止流水线</option>
            <option value="continue">跳过继续</option>
          </select>

          <label>审批放行按键（blocked 时，逗号分隔）</label>
          <input
            placeholder="enter / y / 1 …"
            value={(cfg.approveKeys ?? []).join(',')}
            onChange={(e) =>
              set({ approveKeys: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })
            }
          />
        </>
      )}

      {isFanin && (
        <>
          <label>汇聚策略</label>
          <select
            value={cfg.requireAll === false ? 'any' : 'all'}
            onChange={(e) => set({ requireAll: e.target.value === 'all' })}
          >
            <option value="all">严格：任一分支失败则流水线失败</option>
            <option value="any">宽容：允许部分分支失败，用成功分支继续</option>
          </select>
        </>
      )}

      <label>独立工作目录（相对流水线目录，可空）</label>
      <input value={cfg.cwd ?? ''} onChange={(e) => set({ cwd: e.target.value })} />
    </div>
  );
}
