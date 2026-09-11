import { useStore } from '../store.js';
import type { DagNodeType } from '@paneflow/shared';

export function Palette() {
  const addNode = useStore((s) => s.addNode);
  const graphs = useStore((s) => s.templateList);
  const loadGraph = useStore((s) => s.loadGraph);

  const add = (type: DagNodeType) => {
    const { innerWidth, innerHeight } = window;
    addNode(type, { x: innerWidth / 2 - 350 + Math.random() * 60, y: innerHeight / 2 - 220 + Math.random() * 60 });
  };

  return (
    <div className="palette">
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
      {(graphs ?? []).length === 0 && <div className="hint" style={{ color: 'var(--text-dim)', fontSize: 11 }}>暂无已保存模板</div>}
    </div>
  );
}
