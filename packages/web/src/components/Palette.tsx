import { useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.js';
import type { DagGraph, DagNodeType } from '@paneflow/shared';
import { PromptModal, type ModalRequest } from './PromptModal.jsx';
import { isBuiltinTemplate, templateLabel } from '../template-labels.js';

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
  const [modal, setModal] = useState<ModalRequest | null>(null);
  const [advOpen, setAdvOpen] = useState(false);

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
        await api.deleteGraph(g.name);
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
      <div className="pal-hint">推荐路径：从「模板」载入一个骨架，再按需改。</div>

      <h4>
        模板
        <label title="导入模板 JSON" style={{ float: 'right', fontSize: 11, cursor: 'pointer', color: 'var(--text-dim)' }}>
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
        return (
          <div key={g.name} className="tpl-item">
            <button
              className="pal-item tpl-load"
              title={`${label.title}\n${label.use}\n\n模板 ID：${g.name}`}
              onClick={() => loadGraph(g)}
            >
              <span className="tpl-title">
                {isBuiltinTemplate(g.name) ? '📦' : '📋'} {label.title}
              </span>
              {label.use && <span className="tpl-use">{label.use}</span>}
            </button>
            <div className="tpl-ops">
              <button title="复制另存" onClick={() => duplicate(g)}>⧉</button>
              <button title="重命名" onClick={() => rename(g)}>✎</button>
              <button title="导出 JSON" onClick={() => exportTpl(g)}>⤓</button>
              <button className="danger" title="删除" onClick={() => remove(g)}>🗑</button>
            </div>
          </div>
        );
      })}
      {(graphs ?? []).length === 0 && (
        <div className="hint" style={{ color: 'var(--text-dim)', fontSize: 11 }}>当前空间暂无模板</div>
      )}

      <h4>核心</h4>
      <button className="pal-item" onClick={() => add('agent')} title="一个 Agent 节点 = 一个独立终端 Pane，在这里写任务指令">
        ⚙ Agent 节点
      </button>
      <button className="pal-item" onClick={() => add('pipeline')} title="调用另一条模板作为子流水线">
        ⇢ 子流水线
      </button>

      <h4>基础节点</h4>
      <button className="pal-item" onClick={() => add('start')}>▶ 开始</button>
      <button className="pal-item" onClick={() => add('end')}>■ 结束</button>

      <h4>
        高级节点
        <button className="pal-collapse" onClick={() => setAdvOpen((v) => !v)} title="扇出 / 扇入：需要并行时才用">
          {advOpen ? '▾' : '▸'}
        </button>
      </h4>
      {advOpen && (
        <>
          <button
            className="pal-item"
            onClick={() => add('fanout')}
            title="Fan-out：一个节点分出多条线，下游真实并行"
          >
            ⑂ 同时做几件事
          </button>
          <button
            className="pal-item"
            onClick={() => add('fanin')}
            title="Fan-in：多条线汇入，等上游全部完成再往下走"
          >
            ⑀ 等全部做完
          </button>
        </>
      )}
      {modal && <PromptModal req={modal} onClose={() => setModal(null)} />}
    </div>
  );
}
