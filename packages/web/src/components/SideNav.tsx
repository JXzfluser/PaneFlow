import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.js';

const ITEMS: { id: 'tasks' | 'orchestrate' | 'runs' | 'projects' | 'settings'; icon: string; label: string; title: string }[] = [
  { id: 'tasks', icon: '✎', label: '任务', title: '任务：一句话描述需求，自动编排并执行' },
  { id: 'orchestrate', icon: '◇', label: '编排', title: '编排：步骤清单 / 图形画布' },
  { id: 'runs', icon: '▶', label: '运行', title: '运行中心：多流水线总览' },
  { id: 'projects', icon: '📁', label: '项目', title: '项目：总览 / 切换 / 新建（原底部下拉已升格为视图）' },
  { id: 'settings', icon: '⚙', label: '设置', title: '设置（角色/通道/网关/GitHub/环境）' },
];

/** 56px fixed left navigation: 任务 / 编排 / 运行 / 项目 / 设置。
 *  「任务」排第一位（A2）：说需求是主路径，画布是高级模式。
 *  v10-V：项目切换器从底部下拉升格为「项目」视图，这里只留入口，
 *  当前项目名挂在入口 title 上（切换后全站响应式更新，D4）。 */
export function SideNav() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const space = useStore((s) => s.space);
  const [spaceName, setSpaceName] = useState('');

  useEffect(() => {
    void api
      .listSpaces()
      .then((r) => setSpaceName(r.spaces.find((sp) => sp.id === space)?.name ?? space))
      .catch(() => setSpaceName(space));
  }, [space]);

  return (
    <div className="sidenav">
      <img className="sidenav-brand" src="/icon.svg" alt="PaneFlow" title="PaneFlow" />
      {ITEMS.map((it) => (
        <button
          key={it.id}
          className={`sidenav-item ${view === it.id ? 'active' : ''}`}
          title={it.id === 'projects' ? `项目：当前「${spaceName}」` : it.title}
          onClick={() => setView(it.id)}
        >
          <span className="sidenav-icon">{it.icon}</span>
          <span className="sidenav-label">{it.label}</span>
        </button>
      ))}
    </div>
  );
}
