import { useEffect, useState } from 'react';
import { useStore } from '../store.js';

export function PropertyPanel() {
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const nodes = useStore((s) => s.nodes);
  const updateNodeConfig = useStore((s) => s.updateNodeConfig);
  const agentKinds = useStore((s) => s.agentKinds);
  const [roles, setRoles] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    void fetch('/api/roles').then((r) => r.json()).then((d) => setRoles(d.roles ?? []));
  }, []);

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
  const isPipeline = node.data.dagNode.type === 'pipeline';
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
          <label>角色（全局角色库，继承默认 Agent 类型与前置提示）</label>
          <select value={cfg.role ?? ''} onChange={(e) => set({ role: e.target.value || undefined })}>
            <option value="">（无角色）</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>

          <label>Agent 类型（herdr kind，未选角色时必填）</label>
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
              <label>超时（分钟，0=默认30）</label>
              <input
                type="number" min={0} max={240} value={cfg.timeoutMs ? Math.round(cfg.timeoutMs / 60000) : 0}
                onChange={(e) => set({ timeoutMs: (Number(e.target.value) || 0) * 60000 })}
              />
            </div>
          </div>

          <label>澄清循环（grilling：artifact.aligned≠true 时人机问答，适合需求对齐类节点）</label>
          <div className="row">
            <div>
              <select
                value={cfg.clarify ? 'on' : 'off'}
                onChange={(e) => set({ clarify: e.target.value === 'on' ? { maxRounds: 3 } : undefined })}
              >
                <option value="off">关闭</option>
                <option value="on">开启</option>
              </select>
            </div>
            <div>
              {cfg.clarify && (
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={cfg.clarify.maxRounds ?? 3}
                  onChange={(e) => set({ clarify: { maxRounds: Math.max(1, Number(e.target.value) || 3) } })}
                  title="最大问答轮次"
                />
              )}
            </div>
          </div>

          <label>模型网关 / 环境变量（每行 key=值，注入该节点 pane；可把 Agent 指向 LiteLLM/OmniRoute 等网关）</label>
          <textarea
            style={{ minHeight: 52 }}
            value={Object.entries(cfg.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n')}
            onChange={(e) => {
              const env: Record<string, string> = {};
              for (const line of e.target.value.split('\n')) {
                const i = line.indexOf('=');
                if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
              }
              set({ env: Object.keys(env).length ? env : undefined });
            }}
            placeholder={'ANTHROPIC_BASE_URL=http://127.0.0.1:4000\nOPENAI_API_BASE=http://127.0.0.1:4000/v1'}
          />

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

      {isPipeline && (
        <>
          <label>目标模板名（支持 {'{{上游.artifact.*}}'} 插值做路由）</label>
          <input
            value={cfg.pipeline?.template ?? ''}
            onChange={(e) => set({ pipeline: { ...cfg.pipeline, template: e.target.value } })}
            placeholder="{{triage.artifact.extra.suggestedTemplate}}"
          />
          <label>兜底模板（目标不存在时使用）</label>
          <input
            value={cfg.pipeline?.fallbackTemplate ?? ''}
            onChange={(e) => set({ pipeline: { ...cfg.pipeline, fallbackTemplate: e.target.value || undefined } })}
            placeholder="builtin-generic-issue-delivery"
          />
          <label>参数（key=值，每行一个；值支持插值）</label>
          <textarea
            style={{ minHeight: 60 }}
            value={Object.entries(cfg.pipeline?.params ?? {}).map(([k, v]) => `${k}=${v}`).join('\n')}
            onChange={(e) => {
              const params: Record<string, string> = {};
              for (const line of e.target.value.split('\n')) {
                const i = line.indexOf('=');
                if (i > 0) params[line.slice(0, i).trim()] = line.slice(i + 1).trim();
              }
              set({ pipeline: { ...cfg.pipeline, params } });
            }}
            placeholder={'issue_id={{triage.artifact.extra.issue_id}}'}
          />
          <label>执行模式</label>
          <select
            value={cfg.pipeline?.mode ?? 'wait'}
            onChange={(e) => set({ pipeline: { ...cfg.pipeline, mode: e.target.value as 'wait' | 'fire' } })}
          >
            <option value="wait">等待子运行完成（镜像结果）</option>
            <option value="fire">即发即忘</option>
          </select>
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
