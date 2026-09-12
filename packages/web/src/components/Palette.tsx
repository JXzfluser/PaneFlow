import { useEffect, useState } from 'react';
import { api, getSpace, setSpace } from '../api.js';
import { useStore } from '../store.js';
import type { DagGraph, DagNodeType } from '@paneflow/shared';

export function Palette() {
  const addNode = useStore((s) => s.addNode);
  const graphs = useStore((s) => s.templateList);
  const loadGraph = useStore((s) => s.loadGraph);
  const setTemplates = useStore((s) => s.setTemplates);
  const log = useStore((s) => s.log);
  const space = getSpace();
  const [spaces, setSpaces] = useState<{ id: string; name: string }[]>([{ id: 'default', name: '默认空间' }]);

  useEffect(() => {
    void api.listSpaces().then((r) => setSpaces(r.spaces));
  }, []);

  const switchSpace = async (id: string) => {
    if (id === space) return;
    setSpace(id);
    const r = await api.listGraphs();
    setTemplates(r.graphs);
    useStore.setState({ nodes: [], edges: [], selectedNodeId: null, activeRunId: null, runs: {} });
    log('info', `已切换空间 → ${id}`);
  };

  const newSpace = async () => {
    const id = window.prompt('新空间 ID（字母/数字/-/_）');
    if (!id) return;
    const name = window.prompt('空间名称', id) || id;
    try {
      await api.createSpace(id, name);
      await switchSpace(id);
    } catch (e) {
      log('error', `创建空间失败：${(e as Error).message}`);
    }
  };

  const add = (type: DagNodeType) => {
    const { innerWidth, innerHeight } = window;
    addNode(type, { x: innerWidth / 2 - 350 + Math.random() * 60, y: innerHeight / 2 - 220 + Math.random() * 60 });
  };

  const refresh = () => api.listGraphs().then((r) => setTemplates(r.graphs));

  // -- template operations -----------------------------------------------------

  const tplName = (g: DagGraph) => g.name.replace(/^builtin-/, '').replace(/-/g, ' ');

  const duplicate = async (g: DagGraph) => {
    const name = window.prompt(`复制「${g.name}」为：`, `${g.name}-copy`);
    if (!name) return;
    try {
      await api.saveGraph({ ...structuredClone(g), name });
      await refresh();
      log('info', `已复制为「${name}」`);
    } catch (e) {
      log('error', `复制失败：${(e as Error).message}`);
    }
  };

  const rename = async (g: DagGraph) => {
    const name = window.prompt('新模板名', g.name);
    if (!name || name === g.name) return;
    try {
      await api.saveGraph({ ...structuredClone(g), name });
      await api.deleteGraph(g.name);
      await refresh();
      log('info', `已重命名为「${name}」`);
    } catch (e) {
      log('error', `重命名失败：${(e as Error).message}`);
    }
  };

  const remove = async (g: DagGraph) => {
    if (!window.confirm(`删除模板「${g.name}」？（画布不受影响）`)) return;
    try {
      await api.deleteGraph(g.name);
      await refresh();
      log('info', `模板「${g.name}」已删除`);
    } catch (e) {
      log('error', `删除失败：${(e as Error).message}`);
    }
  };

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
      <h4>
        空间
        <button
          onClick={() => void newSpace()}
          title="新建项目空间（模板与运行记录互相隔离）"
          style={{ float: 'right', padding: '0 7px', fontSize: 11 }}
        >
          +
        </button>
      </h4>
      <select
        value={space}
        onChange={(e) => void switchSpace(e.target.value)}
        style={{ width: '100%', background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', marginBottom: 8 }}
        title="项目空间：模板与运行记录的隔离边界"
      >
        {spaces.map((sp) => (
          <option key={sp.id} value={sp.id}>{sp.name}</option>
        ))}
      </select>
      <h4>基础节点</h4>
      <button className="pal-item" onClick={() => add('start')}>▶ 开始</button>
      <button className="pal-item" onClick={() => add('end')}>■ 结束</button>
      <h4>编排节点</h4>
      <button className="pal-item" onClick={() => add('fanout')}>⑂ 并行 Fan-out</button>
      <button className="pal-item" onClick={() => add('fanin')}>⑀ 汇总 Fan-in</button>
      <h4>核心</h4>
      <button className="pal-item" onClick={() => add('agent')}>⚙ Agent 节点</button>
      <button className="pal-item" onClick={() => add('pipeline')}>⇢ 子流水线</button>
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
      {(graphs ?? []).map((g) => (
        <div key={g.name} className="tpl-item">
          <button className="pal-item tpl-load" title={g.metadata.description || g.name} onClick={() => loadGraph(g)}>
            {g.name.startsWith('builtin-') ? '📦' : '📋'} {tplName(g)}
          </button>
          <div className="tpl-ops">
            <button title="复制另存" onClick={() => void duplicate(g)}>⧉</button>
            <button title="重命名" onClick={() => void rename(g)}>✎</button>
            <button title="导出 JSON" onClick={() => exportTpl(g)}>⤓</button>
            <button className="danger" title="删除" onClick={() => void remove(g)}>🗑</button>
          </div>
        </div>
      ))}
      {(graphs ?? []).length === 0 && <div className="hint" style={{ color: 'var(--text-dim)', fontSize: 11 }}>当前空间暂无模板</div>}
    </div>
  );
}
