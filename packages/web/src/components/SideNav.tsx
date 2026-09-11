import type React from 'react';
import { useEffect, useState } from 'react';
import { api, getSpace, setSpace } from '../api.js';
import { useStore } from '../store.js';

const ITEMS: { id: 'orchestrate' | 'runs' | 'settings'; icon: string; label: string; title: string }[] = [
  { id: 'orchestrate', icon: '◇', label: '编', title: '编排画布' },
  { id: 'runs', icon: '▶', label: '运', title: '运行中心' },
  { id: 'settings', icon: '⚙', label: '设', title: '设置（空间/角色/通知/环境）' },
];

/** 56px fixed left navigation (B8): 编 / 运 / 设 + bottom space switcher. */
export function SideNav() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const space = getSpace();
  const setTemplates = useStore((s) => s.setTemplates);
  const log = useStore((s) => s.log);
  const [spaces, setSpaces] = useState<{ id: string; name: string }[]>([{ id: 'default', name: '默认' }]);

  useEffect(() => {
    void api.listSpaces().then((r) => setSpaces(r.spaces));
  }, []);

  const onSpaceChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = (e.target as HTMLSelectElement).value;
    if (id === space) return;
    setSpace(id);
    const r = await api.listGraphs();
    setTemplates(r.graphs);
    useStore.setState({ nodes: [], edges: [], selectedNodeId: null, activeRunId: null, runs: {} });
    log('info', `已切换空间 → ${id}`);
  };

  return (
    <div className="sidenav">
      <div className="sidenav-brand">P</div>
      {ITEMS.map((it) => (
        <button
          key={it.id}
          className={`sidenav-item ${view === it.id ? 'active' : ''}`}
          title={it.title}
          onClick={() => setView(it.id)}
        >
          <span className="sidenav-icon">{it.icon}</span>
          <span className="sidenav-label">{it.label}</span>
        </button>
      ))}
      <div className="sidenav-bottom">
        <select
          className="sidenav-space"
          value={space}
          onChange={(e) => void onSpaceChange(e)}
          title="项目空间"
        >
          {spaces.map((sp) => (
            <option key={sp.id} value={sp.id}>{sp.name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
