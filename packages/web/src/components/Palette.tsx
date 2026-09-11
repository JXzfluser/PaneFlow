import { useEffect, useState } from 'react';
import { api, getSpace, setSpace } from '../api.js';
import { useStore } from '../store.js';
import type { DagNodeType } from '@paneflow/shared';

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
      <h4>模板</h4>
      {(graphs ?? []).map((g) => (
        <button
          key={g.name}
          className="pal-item"
          title={g.metadata.description || g.name}
          onClick={() => loadGraph(g)}
        >
          {g.name.startsWith('builtin-') ? '📦' : '📋'}{' '}
          {g.name.replace(/^builtin-/, '').replace(/-/g, ' ')}
        </button>
      ))}
      {(graphs ?? []).length === 0 && <div className="hint" style={{ color: 'var(--text-dim)', fontSize: 11 }}>当前空间暂无模板</div>}
    </div>
  );
}
