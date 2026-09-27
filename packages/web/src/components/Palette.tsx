import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.js';
import type { DagGraph, DagNodeType } from '@paneflow/shared';
import { PromptModal, type ModalRequest } from './PromptModal.jsx';
import { isBuiltinTemplate, templateLabel } from '../template-labels.js';
import { requirementBadge, requirementDetail, type RegistryCheckRow, type RegistryEntryView } from '../registry-view.js';
import { paletteGroups } from '../node-types.js';

/** 模板名前端校验：只挡空名与路径分隔符，字符集仍由用户自由决定。 */
const validateTplName = (v: string): string | null => {
  const name = v.trim();
  if (!name) return '名称不能为空';
  if (/[/\\]/.test(name)) return '名称不能包含 / 或 \\';
  if (name.length > 80) return '名称过长（≤80 字符）';
  return null;
};

export function Palette() {
  const addNode = useStore((s) => s.addNode);
  const graphs = useStore((s) => s.templateList);
  const loadGraph = useStore((s) => s.loadGraph);
  const setTemplates = useStore((s) => s.setTemplates);
  const log = useStore((s) => s.log);
  const graphName = useStore((s) => s.graphName);
  const space = useStore((s) => s.space);
  const [modal, setModal] = useState<ModalRequest | null>(null);
  const [advOpen, setAdvOpen] = useState(false);
  /**
   * v14-T3 预检读数（一次拿全部模板，不是一卡一发请求）。`null` = 还没读到/读失败了——
   * 那时带槽的卡画「预检没读出」灰字，**绝不画 ✓**：缺口最坏的样子就是看着没事。
   */
  const [checks, setChecks] = useState<Map<string, RegistryCheckRow> | null>(null);
  /**
   * v14 T1 节点类型清单（`GET /api/registry?kind=node-type`）。`null` = 还没读到/读失败——
   * 那时这一节画一句「没读到」而**不画任何按钮**：这里绝不拿本 bundle 的硬编码清单兜底，
   * 那份第二事实源正是本片要拆掉的东西（旧 server 连这一刀都没有，见下方指路文案）。
   */
  const [nodeTypes, setNodeTypes] = useState<RegistryEntryView[] | null>(null);
  const [nodeTypesError, setNodeTypesError] = useState<string | null>(null);

  const loadNodeTypes = () => {
    setNodeTypes(null);
    setNodeTypesError(null);
    api
      .registryList('node-type')
      .then((r) => setNodeTypes(r.entries))
      .catch((e: Error) => {
        setNodeTypes(null);
        setNodeTypesError(e.message || '服务端没答上');
      });
  };

  useEffect(() => {
    loadNodeTypes();
  }, []);

  useEffect(() => {
    let alive = true;
    setChecks(null); // 换项目先把上一个项目的命中收掉，不拿旧读数糊这张卡
    api
      .registryCheck()
      .then((r) => {
        if (alive) setChecks(new Map(r.templates.map((t) => [t.template, t])));
      })
      .catch(() => {
        if (alive) setChecks(null);
      });
    return () => {
      alive = false;
    };
  }, [space]);

  const add = (type: DagNodeType) => {
    const { innerWidth, innerHeight } = window;
    addNode(type, { x: innerWidth / 2 - 350 + Math.random() * 60, y: innerHeight / 2 - 220 + Math.random() * 60 });
  };

  const refresh = () => api.listGraphs().then((r) => setTemplates(r.graphs));

  // -- template operations -----------------------------------------------------

  const duplicate = (g: DagGraph) =>
    setModal({
      title: '复制模板',
      message: `以「${templateLabel(g.name, g.metadata.description).title}」为蓝本另存为新模板。`,
      fields: [
        { key: 'name', label: '新模板名', defaultValue: `${g.name}-copy`, validate: validateTplName },
      ],
      confirmText: '复制',
      onSubmit: async ({ name }) => {
        const next = (name ?? '').trim();
        await api.saveGraph({ ...structuredClone(g), name: next });
        await refresh();
        log('info', `已复制为「${next}」`);
      },
    });

  const rename = (g: DagGraph) =>
    setModal({
      title: '重命名模板',
      message: `当前 ID：${g.name}`,
      fields: [{ key: 'name', label: '新模板名', defaultValue: g.name, validate: validateTplName }],
      confirmText: '重命名',
      onSubmit: async ({ name }) => {
        const next = (name ?? '').trim();
        if (!next || next === g.name) return; // 未改动，直接关闭
        await api.saveGraph({ ...structuredClone(g), name: next });
        try {
          await api.deleteGraph(g.name);
        } catch (e) {
          // 重命名=另存+删旧。旧名还被别的图当子流水线指着时，删除侧的闸（A5-5a）会拦下这一步——
          // 此刻新模板**已经落盘**，所以先把列表刷出来，再说清「现在是两份」，不拿「重命名失败」冒充整件事没发生。
          await refresh();
          throw new Error(`已另存为「${next}」，但旧模板「${g.name}」没删掉（列表里现在两份都在）：${(e as Error).message}`);
        }
        await refresh();
        log('info', `已重命名为「${next}」`);
      },
    });

  const remove = (g: DagGraph) =>
    setModal({
      title: '删除模板',
      message: `确认删除模板「${templateLabel(g.name, g.metadata.description).title}」（${g.name}）？画布不受影响。`,
      confirmText: '删除',
      danger: true,
      onSubmit: async () => {
        await api.deleteGraph(g.name);
        await refresh();
        log('info', `模板「${g.name}」已删除`);
      },
    });

  const exportTpl = (g: DagGraph) => {
    const blob = new Blob([JSON.stringify(g, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${g.name}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importTpl = async (file: File) => {
    try {
      const graph = JSON.parse(await file.text()) as DagGraph;
      if (graph?.version !== 1 || !Array.isArray(graph.nodes)) throw new Error('不是有效的 PaneFlow 模板');
      await api.saveGraph(graph);
      await refresh();
      log('info', `已导入模板「${graph.name}」`);
    } catch (e) {
      log('error', `导入失败：${(e as Error).message}`);
    }
  };

  return (
    <div className="palette">
      <div className="pal-hint">推荐路径：从「模板」载入一个骨架，再按需改。模板全局共享，所有项目都能用。</div>

      <h4>
        模板
        <label className="pal-import" title="导入模板 JSON">
          导入
          <input
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importTpl(f);
              e.currentTarget.value = '';
            }}
          />
        </label>
      </h4>
      {(graphs ?? []).map((g) => {
        const label = templateLabel(g.name, g.metadata.description);
        const loaded = g.name === graphName;
        const row = checks?.get(g.name);
        const badge = requirementBadge(row, g.requires?.length ?? 0);
        const mark = badge.tone === 'ok' ? '✓' : badge.tone === 'gap' ? '✗' : badge.tone === 'pending' ? '?' : badge.tone === 'unknown' ? '…' : '';
        return (
          <div key={g.name} className={`tpl-item${loaded ? ' on' : ''}`}>
            <button
              className="tpl-load"
              title={`${label.title}\n${label.use}\n\n模板 ID：${g.name}${row ? `\n\n${requirementDetail(row)}` : ''}`}
              onClick={() => loadGraph(g)}
            >
              <span className="tpl-title">
                {isBuiltinTemplate(g.name) ? '📦' : '📋'} {label.title}
              </span>
              {label.use && <span className="tpl-use">{label.use}</span>}
              {badge.tone !== 'none' && (
                <span className={`tpl-req tone-${badge.tone}`}>
                  {mark} {badge.text}
                </span>
              )}
            </button>
            <div className="tpl-ops">
              <button title="复制另存" aria-label="复制模板" onClick={() => duplicate(g)}>⧉</button>
              <button title="重命名" aria-label="重命名模板" onClick={() => rename(g)}>✎</button>
              <button title="导出 JSON" aria-label="导出模板" onClick={() => exportTpl(g)}>⤓</button>
              <button className="danger" title="删除" aria-label="删除模板" onClick={() => remove(g)}>🗑</button>
            </div>
          </div>
        );
      })}
      {(graphs ?? []).length === 0 && (
        <div className="hint" style={{ color: 'var(--text-dim)', fontSize: 11 }}>还没有模板——点上方「导入」，或到「⋯ 更多」从 GitHub 拉取</div>
      )}

      <h4>节点类型</h4>
      {(() => {
        if (nodeTypes === null) {
          return (
            <div className="hint" style={{ color: 'var(--text-dim)', fontSize: 11 }}>
              节点类型清单没读到{nodeTypesError ? `：${nodeTypesError}` : ''}。
              <br />
              这一版面板只画服务端注册表里的类型，不在这里留一份兜底清单。
              <br />
              <button className="pal-item" onClick={loadNodeTypes}>重新读取清单</button>
            </div>
          );
        }
        const { groups, unusable } = paletteGroups(nodeTypes);
        return (
          <>
            {groups.map(({ group, label, nodes }) => {
              // 「高级」默认收起是本页的排版习惯（不是清单里的字段），组名来自 shared 的词表
              const collapsible = group === 'advanced';
              const open = !collapsible || advOpen;
              return (
                <div key={group}>
                  <h4>
                    {label}
                    {collapsible && (
                      <button className="pal-collapse" onClick={() => setAdvOpen((v) => !v)} title="扇出 / 扇入：需要并行时才用">
                        {advOpen ? '▾' : '▸'}
                      </button>
                    )}
                  </h4>
                  {open &&
                    nodes.map((n) => (
                      <button key={n.type} className="pal-item" onClick={() => add(n.type)} title={n.hint}>
                        {n.icon} {n.label}
                      </button>
                    ))}
                </div>
              );
            })}
            {unusable.length > 0 && (
              <div className="hint" style={{ color: 'var(--text-dim)', fontSize: 11 }}>
                {unusable.length} 项读不出画法，不给拖：
                {unusable.map((u) => (
                  <div key={u.name} title={u.why}>
                    · {u.name}：{u.why}
                  </div>
                ))}
              </div>
            )}
            {groups.length === 0 && unusable.length === 0 && (
              <div className="hint" style={{ color: 'var(--text-dim)', fontSize: 11 }}>
                服务端这一版没交出节点类型（清单是空的）——不是你这里坏了，去注册中心那一页看读数。
              </div>
            )}
          </>
        );
      })()}
      {modal && <PromptModal req={modal} onClose={() => setModal(null)} />}
    </div>
  );
}
