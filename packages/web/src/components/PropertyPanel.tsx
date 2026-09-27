import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.js';
import type { CheckSpec, DagNode, EdgeCondition } from '@paneflow/shared';
import { REJECT_LIMIT_DEFAULT, REJECT_LIMIT_MAX } from '@paneflow/shared';
import { checkTypeButtons, blankCheck } from '../check-types.js';
import type { RegistryEntryView } from '../registry-view.js';

type NodeConfig = DagNode['config'];

/**
 * 「高级设置」里已配置的项（B1）：用于折叠区计数徽标 + 切节点时自动展开。
 * 只看有实际取值的高级字段，默认值（abort / 0 / 空）不算。
 */
function advancedItems(cfg: NodeConfig): string[] {
  const out: string[] = [];
  if ((cfg.retryCount ?? 0) > 0) out.push('重试');
  if (cfg.rejectLimit) out.push('打回上限');
  if ((cfg.timeoutMs ?? 0) > 0) out.push('超时');
  if (cfg.clarify) out.push('澄清循环');
  if (cfg.env && Object.keys(cfg.env).length > 0) out.push('环境变量');
  if (cfg.checks && cfg.checks.length > 0) out.push('检查门禁');
  if (cfg.onFail && cfg.onFail !== 'abort') out.push('失败策略');
  if (cfg.approveKeys && cfg.approveKeys.length > 0) out.push('放行按键');
  if (cfg.cwd) out.push('工作目录');
  return out;
}

export function PropertyPanel() {
  const selectedEdgeId = useStore((s) => s.selectedEdgeId);
  if (selectedEdgeId) {
    return <EdgeConditionPanel edgeId={selectedEdgeId} />;
  }
  return <NodePropertyPanel />;
}

/** 条件边编辑（R2.1）：断言上游 artifact 字段，不满足即剪枝；v13-K2 同一面板兼作「打回线」开关 */
function EdgeConditionPanel({ edgeId }: { edgeId: string }) {
  const edges = useStore((s) => s.edges);
  const nodes = useStore((s) => s.nodes);
  const updateEdgeCondition = useStore((s) => s.updateEdgeCondition);
  const updateEdgeReject = useStore((s) => s.updateEdgeReject);
  const selectEdge = useStore((s) => s.selectEdge);
  const edge = edges.find((e) => e.id === edgeId);
  if (!edge) {
    return <div className="props"><h3>属性 · 连线</h3><div className="hint">连线不存在。</div></div>;
  }
  const cond = edge?.data?.condition as EdgeCondition | undefined;
  const isReject = edge.data?.reject === true;
  // 端点形状提示用的（判据在 server 的 validateDag，这里只提前说人话，不自作拦截）
  const kindOf = (id: string) => nodes.find((n) => n.id === id)?.data.dagNode.type;
  const endpointsWrong = isReject && (kindOf(edge.source) !== 'agent' || kindOf(edge.target) !== 'agent');
  const set = (patch: Partial<EdgeCondition>) =>
    updateEdgeCondition(edgeId, {
      field: patch.field ?? cond?.field ?? '',
      equals: patch.equals !== undefined ? patch.equals : cond?.equals,
      notEquals: patch.notEquals !== undefined ? patch.notEquals : cond?.notEquals,
      exists: patch.exists !== undefined ? patch.exists : cond?.exists,
    } as EdgeCondition);
  return (
    <div className="props">
      <h3>{isReject ? '打回线' : '条件边'} · {edge.source} → {edge.target}</h3>
      <label className="flag-row">
        <input
          type="checkbox"
          checked={isReject}
          onChange={(e) => updateEdgeReject(edgeId, e.target.checked)}
        />
        <span>这条线是否决回边（打回）：「{edge.target}」被拒后带理由重跑</span>
      </label>
      <p className="hint" style={{ margin: '6px 0 8px' }}>
        {isReject
          ? '下面的断言就是「什么时候算否决」——对「' + edge.source + '」的产物字段做判断，成立才打回；不成立这一步就正常往下走。'
          : '运行时对「' + edge.source + '」的产物字段做断言：不满足则此连线被剪枝，下游按依赖缺失跳过。'}
      </p>
      {isReject && (
        <div className={`hint${endpointsWrong || !cond?.field ? ' warn' : ''}`}>
          {endpointsWrong
            ? '打回的两端都得是 Agent 节点（否决要有产物可依据、被拒方要能重跑）——保存时会被拒。'
            : !cond?.field
              ? '打回线必须带断言：没有断言就是恒打回，回路只会靠上限兜住——保存时会被拒。'
              : '被拒方重跑的次数上限在它自己的「高级设置 · 打回上限」里（默认 2 次）。'}
        </div>
      )}
      <label>artifact 字段（如 {isReject ? 'extra.decision' : 'aligned / status'}）</label>
      <input
        value={cond?.field ?? ''}
        onChange={(e) => set({ field: e.target.value })}
        placeholder="aligned"
      />
      <label>断言</label>
      <select
        value={cond?.equals !== undefined ? 'equals' : cond?.notEquals !== undefined ? 'notEquals' : cond?.exists !== undefined ? 'exists' : 'none'}
        onChange={(e) => {
          const mode = e.target.value;
          if (mode === 'equals') set({ equals: cond?.equals ?? 'true', notEquals: undefined, exists: undefined });
          else if (mode === 'notEquals') set({ notEquals: cond?.notEquals ?? '', equals: undefined, exists: undefined });
          else set({ exists: true, equals: undefined, notEquals: undefined });
        }}
      >
        <option value="none">无条件（恒通过）</option>
        <option value="equals">字段 == 期望值</option>
        <option value="notEquals">字段 != 排除值</option>
        <option value="exists">字段存在</option>
      </select>
      {(cond?.equals !== undefined || cond?.notEquals !== undefined) && (
        <>
          <label>{cond?.equals !== undefined ? '期望值' : '排除值'}</label>
          <input
            value={cond?.equals ?? cond?.notEquals ?? ''}
            onChange={(e) =>
              cond?.equals !== undefined
                ? set({ equals: e.target.value })
                : set({ notEquals: e.target.value })
            }
          />
        </>
      )}
      <button
        style={{ marginTop: 10 }}
        onClick={() => {
          updateEdgeCondition(edgeId, undefined);
          selectEdge(null);
        }}
      >
        移除条件（恢复恒通过）
      </button>
      <div className="hint" style={{ marginTop: 10 }}>
        提示：条件在运行时评估（预演可静态展开）；条件不满足的下游分支会被跳过。
      </div>
    </div>
  );
}

function NodePropertyPanel() {
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const nodes = useStore((s) => s.nodes);
  const updateNodeConfig = useStore((s) => s.updateNodeConfig);
  const agentKinds = useStore((s) => s.agentKinds);
  const templateList = useStore((s) => s.templateList);
  const [roles, setRoles] = useState<{ id: string; name: string }[]>([]);
  const [advOpen, setAdvOpen] = useState(false);
  /**
   * v14-A5-4 机检类型清单（`GET /api/registry?kind=check-type`）。`null` = 还没读到/读失败——
   * 那时「检查门禁」这一节画一句指路而**不画加号**，与侧栏「节点类型」同款：
   * 这里绝不拿本 bundle 的硬编码四枚兜底，那份第二事实源正是本片要拆掉的东西
   * （而且它一直少着 `contract` 与 `delivery-branch`——两型引擎认得、画布上加不出来）。
   */
  const [checkTypes, setCheckTypes] = useState<RegistryEntryView[] | null>(null);
  const [checkTypesError, setCheckTypesError] = useState<string | null>(null);
  const loadCheckTypes = () => {
    setCheckTypes(null);
    setCheckTypesError(null);
    api
      .registryList('check-type')
      .then((r) => setCheckTypes(r.entries))
      .catch((e: Error) => {
        setCheckTypes(null);
        setCheckTypesError(e.message || '服务端没答上');
      });
  };
  useEffect(() => {
    void fetch('/api/roles').then((r) => r.json()).then((d) => setRoles(d.roles ?? []));
    loadCheckTypes();
  }, []);
  // 切换选中节点时重置折叠态：已配过高级项就展开，否则默认收起（B1）
  useEffect(() => {
    const n = useStore.getState().nodes.find((x) => x.id === selectedNodeId);
    setAdvOpen(advancedItems(n?.data.dagNode.config ?? {}).length > 0);
  }, [selectedNodeId]);

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
  const isFanout = node.data.dagNode.type === 'fanout';
  const set = (patch: Parameters<typeof updateNodeConfig>[1]) => updateNodeConfig(node.id, patch);
  const advItems = advancedItems(cfg);
  /** 清单没读到就是 `null`（不是空读数）——上面那一格区分「还没读到」与「读出来是零」 */
  const checkBtns = checkTypes === null ? null : checkTypeButtons(checkTypes);
  const labelOf = (t: string) => checkBtns?.buttons.find((b) => b.type === t);

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

          <label title="AE：留「自动」时运行时按 项目默认→本机已装推荐（pi 优先）解析">Agent 类型（herdr kind）</label>
          <select value={cfg.agentKind ?? ''} onChange={(e) => set({ agentKind: e.target.value || undefined })}>
            <option value="">自动（项目默认 → 已装推荐）</option>
            {agentKinds.map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>

          <label>任务指令（prompt）<span className="req-mark">*</span></label>
          <textarea
            placeholder={'要完成的任务。可引用上游产物：{{nodeId.artifact.summary}} 或 {{nodeId.output}}'}
            value={cfg.prompt ?? ''}
            onChange={(e) => set({ prompt: e.target.value })}
          />
          <div className="hint">
            系统会自动附加「结果写入 .herdr/artifact.json」的交接约定。
            <br />
            要上游整份原文用硬引用 <code>{'{{artifact:节点ID/产物名}}'}</code>（产物名 = 上游在 artifact.json 的 products
            里声明的命名产物，引擎读原文上架）；解析不到本节点直接失败，不会拿空串充数。点引用 <code>{'{{nodeId.artifact.x}}'}</code> 解析不到只留字面量。
          </div>

          <button
            className="adv-toggle"
            onClick={() => setAdvOpen((v) => !v)}
            title="重试 / 超时 / 打回上限 / 澄清循环 / 环境变量 / 检查门禁 / 失败策略 / 放行按键 / 独立工作目录"
          >
            <span>{advOpen ? '▾' : '▸'}</span>
            <span>高级设置</span>
            {advItems.length > 0 && (
              <span className="adv-badge" title={`已配置：${advItems.join('、')}`}>
                已配置 {advItems.length} 项
              </span>
            )}
          </button>
          <div className="adv-body" data-open={advOpen ? '1' : '0'}>
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
            <div>
              {/* v13-K2 打回上限：能被哪些回边拒几次（判据与默认值都取自 shared，不在这里抄一份） */}
              <label>打回上限</label>
              <select
                value={cfg.rejectLimit ?? ''}
                onChange={(e) => set({ rejectLimit: e.target.value ? Number(e.target.value) : undefined })}
              >
                <option value="">默认 {REJECT_LIMIT_DEFAULT} 次</option>
                {Array.from({ length: REJECT_LIMIT_MAX }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>{n} 次</option>
                ))}
              </select>
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

          <label>检查门禁（done 后全部通过才算完成）</label>
          {(cfg.checks ?? []).length === 0 && (
            <div className="hint" style={{ marginBottom: 6 }}>未配置检查。</div>
          )}
          {(cfg.checks ?? []).map((c, i) => (
            <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: 6, marginBottom: 6 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ color: 'var(--accent)', fontSize: 11 }} title={labelOf(c.type)?.hint}>
                  {labelOf(c.type)?.label ?? c.type}
                </span>
                {labelOf(c.type) && (
                  <span className="hint" style={{ fontSize: 10 }}>{labelOf(c.type)?.machine ? '引擎实跑' : '人看一眼'}</span>
                )}
                <button
                  className="danger"
                  style={{ marginLeft: 'auto', padding: '0 6px', fontSize: 10 }}
                  onClick={() => set({ checks: (cfg.checks ?? []).filter((_, j) => j !== i) })}
                >
                  🗑
                </button>
              </div>
              {c.type === 'file-exists' && (
                <input value={c.path} onChange={(e) => set({ checks: (cfg.checks ?? []).map((x, j) => (j === i ? { ...x, path: e.target.value } : x)) })} placeholder="相对路径 ok.txt" />
              )}
              {c.type === 'command' && (
                <input value={c.run} onChange={(e) => set({ checks: (cfg.checks ?? []).map((x, j) => (j === i ? { ...x, run: e.target.value } : x)) })} placeholder="npm test" />
              )}
              {c.type === 'regex' && (
                <>
                  <input value={c.file} onChange={(e) => set({ checks: (cfg.checks ?? []).map((x, j) => (j === i ? { ...x, file: e.target.value } : x)) })} placeholder="report.md" />
                  <input value={c.pattern} onChange={(e) => set({ checks: (cfg.checks ?? []).map((x, j) => (j === i ? { ...x, pattern: e.target.value } : x)) })} placeholder="PASS" />
                </>
              )}
              {c.type === 'manual' && (
                <input value={c.prompt} onChange={(e) => set({ checks: (cfg.checks ?? []).map((x, j) => (j === i ? { ...x, prompt: e.target.value } : x)) })} placeholder="冒烟通过？" />
              )}
              {c.type === 'contract' && (
                <input
                  value={c.template ?? ''}
                  onChange={(e) => set({ checks: (cfg.checks ?? []).map((x, j) => (j === i ? { ...x, template: e.target.value || undefined } : x)) })}
                  placeholder="契约骨架戳 template=id@sha（可空）"
                />
              )}
              {c.type === 'delivery-branch' && (
                <input
                  value={c.expectBranch ?? ''}
                  onChange={(e) => set({ checks: (cfg.checks ?? []).map((x, j) => (j === i ? { ...x, expectBranch: e.target.value || undefined } : x)) })}
                  placeholder="期望分支（留空=按家规渲染，再空则 pf/<runId>）"
                />
              )}
            </div>
          ))}
          {checkBtns === null ? (
            <div className="hint" style={{ marginBottom: 6 }}>
              机检类型清单没读到{checkTypesError ? `：${checkTypesError}` : ''}。
              <br />
              这一版面板只画服务端注册表里的机检类型，不在这里留一份兜底清单。
              <br />
              <button style={{ fontSize: 11 }} onClick={loadCheckTypes}>重新读取清单</button>
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
                {checkBtns.buttons.map((b) => (
                  <button
                    key={b.type}
                    style={{ fontSize: 11 }}
                    title={`${b.hint}（${b.machine ? '引擎实跑' : '人看一眼'}）`}
                    onClick={() => {
                      const blank = blankCheck(b.type);
                      if (!blank) return;
                      set({ checks: [...(cfg.checks ?? []), blank as CheckSpec] });
                    }}
                  >
                    +{b.label}
                  </button>
                ))}
              </div>
              {checkBtns.unusable.length > 0 && (
                <div className="hint" style={{ marginBottom: 6 }}>
                  {checkBtns.unusable.length} 项读不出画法，不加：
                  {checkBtns.unusable.map((u) => (
                    <div key={u.name} title={u.why}>
                      · {u.name}：{u.why}
                    </div>
                  ))}
                </div>
              )}
              {checkBtns.buttons.length === 0 && checkBtns.unusable.length === 0 && (
                <div className="hint" style={{ marginBottom: 6 }}>
                  服务端这一版没交出机检类型（清单是空的）——不是你这里坏了，去注册中心那一页看读数。
                </div>
              )}
            </>
          )}

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

          <label>独立工作目录（相对流水线目录，可空）</label>
          <CwdInput value={cfg.cwd ?? ''} onChange={(v) => set({ cwd: v || undefined })} />
          </div>
        </>
      )}

      {isPipeline && (
        <>
          <label>目标模板（可从列表选，也支持 {'{{上游.artifact.*}}'} 插值路由）</label>
          <input
            list="pp-tpl-list"
            value={cfg.pipeline?.template ?? ''}
            onChange={(e) => set({ pipeline: { ...cfg.pipeline, template: e.target.value } })}
            placeholder="选择或输入模板名"
          />
          <datalist id="pp-tpl-list">
            {templateList.map((g) => <option key={g.name} value={g.name} />)}
          </datalist>
          <label>兜底模板（目标不存在时使用）</label>
          <input
            list="pp-tpl-list-fb"
            value={cfg.pipeline?.fallbackTemplate ?? ''}
            onChange={(e) => set({ pipeline: { ...cfg.pipeline, fallbackTemplate: e.target.value || undefined } })}
            placeholder="选择或输入兜底模板名"
          />
          <datalist id="pp-tpl-list-fb">
            {templateList.map((g) => <option key={g.name} value={g.name} />)}
          </datalist>
          <label>参数（值支持插值）</label>
          {Object.entries(cfg.pipeline?.params ?? {}).length === 0 && (
            <div className="hint" style={{ marginBottom: 4 }}>未配置参数。</div>
          )}
          {Object.entries(cfg.pipeline?.params ?? {}).map(([k, v], i) => (
            <div key={i} className="row" style={{ alignItems: 'center' }}>
              <input
                style={{ flex: '0 0 35%' }}
                value={k}
                placeholder="参数名"
                onChange={(e) => {
                  const entries = Object.entries(cfg.pipeline?.params ?? {});
                  entries[i] = [e.target.value, v];
                  set({ pipeline: { ...cfg.pipeline, params: Object.fromEntries(entries) } });
                }}
              />
              <input
                style={{ flex: 1 }}
                value={v}
                placeholder="值（支持 {{插值}}）"
                onChange={(e) => {
                  const entries = Object.entries(cfg.pipeline?.params ?? {});
                  entries[i] = [k, e.target.value];
                  set({ pipeline: { ...cfg.pipeline, params: Object.fromEntries(entries) } });
                }}
              />
              <button
                className="danger"
                style={{ padding: '0 6px', fontSize: 10, flex: '0 0 auto' }}
                onClick={() => {
                  const entries = Object.entries(cfg.pipeline?.params ?? {}).filter((_, j) => j !== i);
                  set({ pipeline: { ...cfg.pipeline, params: entries.length ? Object.fromEntries(entries) : undefined } });
                }}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            style={{ fontSize: 11, marginBottom: 4 }}
            onClick={() => {
              const cur = cfg.pipeline?.params ?? {};
              set({ pipeline: { ...cfg.pipeline, params: { ...cur, '': '' } } });
            }}
          >
            + 参数
          </button>
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

      {node.data.dagNode.type === 'fanout' && (
        <>
          <label>动态扇出：从上游产物数组字段展开分支</label>
          <input
            value={cfg.expand ? `${cfg.expand.from}.${cfg.expand.field}` : ''}
            onChange={(e) => {
              const v = e.target.value;
              const dot = v.indexOf('.');
              set({
                expand: v
                  ? { from: v.slice(0, dot > 0 ? dot : undefined) || 'plan', field: dot > 0 ? v.slice(dot + 1) : v }
                  : undefined,
              });
            }}
            placeholder="plan.extra.tasks"
          />
          <label>数组缺失时</label>
          <select
            value={cfg.expand?.onEmpty ?? 'fallback'}
            onChange={(e) => set({ expand: { ...(cfg.expand ?? { from: '', field: '' }), onEmpty: e.target.value as 'fallback' | 'fail' } })}
          >
            <option value="fallback">回退单分支串行交付（推荐）</option>
            <option value="fail">节点失败</option>
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

      {!isAgent && (
        <>
          <label>独立工作目录（相对流水线目录，可空）</label>
          <CwdInput value={cfg.cwd ?? ''} onChange={(v) => set({ cwd: v || undefined })} />
        </>
      )}
    </div>
  );
}

function CwdInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const pipelineCwd = useStore((s) => s.cwd);
  const [open, setOpen] = useState(false);
  const [browseDir, setBrowseDir] = useState('');
  const [entries, setEntries] = useState<string[]>([]);

  const doBrowse = async (dir: string) => {
    try {
      const r = await fetch(`/api/fs/browse?path=${encodeURIComponent(dir)}`);
      const d = await r.json() as { entries?: string[]; dir?: string };
      setEntries((d.entries ?? []).filter((e) => !e.startsWith('.')));
      setBrowseDir(d.dir ?? dir);
    } catch {
      setEntries([]);
    }
  };

  const toggleOpen = () => {
    if (!open) {
      const base = pipelineCwd || '';
      doBrowse(base);
    }
    setOpen((v) => !v);
  };

  const enter = (name: string) => {
    const next = browseDir.endsWith('/') ? browseDir + name : browseDir + '/' + name;
    doBrowse(next);
  };

  const pick = () => {
    if (!pipelineCwd || !browseDir.startsWith(pipelineCwd)) return;
    const rel = browseDir.slice(pipelineCwd.length).replace(/^\/+/, '');
    onChange(rel);
    setOpen(false);
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          style={{ flex: 1 }}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="子目录路径，如 src/components"
        />
        {pipelineCwd && (
          <button className="ghost" style={{ fontSize: 11, whiteSpace: 'nowrap' }} onClick={toggleOpen}>
            {open ? '收起' : '浏览'}
          </button>
        )}
      </div>
      <div className="hint">
        {pipelineCwd
          ? `留空则与流水线工作目录一致。基于：${pipelineCwd}`
          : '留空则与流水线工作目录一致。请先在顶栏设置流水线工作目录。'}
      </div>
      {open && pipelineCwd && (
        <div className="cwd-browser">
          <div className="cwd-browser-path">
            <code style={{ fontSize: 11 }}>{browseDir}</code>
            <button className="ghost tiny" onClick={pick} disabled={!browseDir || browseDir === pipelineCwd}>
              选此目录
            </button>
          </div>
          {entries.length === 0 && <div className="hint">无子目录</div>}
          {entries.map((e) => (
            <button key={e} className="cwd-browser-entry" onClick={() => enter(e)}>
              <span>📁</span> {e}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
