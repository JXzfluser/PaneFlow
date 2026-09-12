import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.js';
import { PromptModal, type ModalRequest } from './PromptModal.jsx';

const ITEMS: { id: 'tasks' | 'orchestrate' | 'runs' | 'settings'; icon: string; label: string; title: string }[] = [
  { id: 'tasks', icon: '✎', label: '任务', title: '任务：一句话描述需求，自动编排并执行' },
  { id: 'orchestrate', icon: '◇', label: '编排', title: '编排：步骤清单 / 图形画布' },
  { id: 'runs', icon: '▶', label: '运行', title: '运行中心：多流水线总览' },
  { id: 'settings', icon: '⚙', label: '设置', title: '设置（空间/角色/通知/环境）' },
];

/** 56px fixed left navigation: 任务 / 编排 / 运行 / 设置 + bottom space switcher.
 *  「任务」排第一位（A2）：说需求是主路径，画布是高级模式。
 *  空间切换器只此一处（B4），状态来自 store.space，切换后全站响应式更新（D4）。 */
export function SideNav() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const space = useStore((s) => s.space);
  const switchSpace = useStore((s) => s.switchSpace);
  const [spaces, setSpaces] = useState<{ id: string; name: string }[]>([{ id: 'default', name: '默认空间' }]);
  const [modal, setModal] = useState<ModalRequest | null>(null);

  useEffect(() => {
    void api.listSpaces().then((r) => setSpaces(r.spaces));
  }, []);

  const newSpace = () =>
    setModal({
      title: '新建项目空间',
      message: '模板与运行记录按空间互相隔离。',
      fields: [
        {
          key: 'id',
          label: '空间 ID',
          placeholder: 'my-project',
          validate: (v) =>
            /^[a-zA-Z0-9_-]{1,32}$/.test(v.trim()) ? null : '只能包含字母 / 数字 / - / _（≤32 字符）',
        },
        {
          key: 'name',
          label: '空间名称',
          placeholder: '我的项目',
          validate: (v, all) => (v.trim() || all.id?.trim() ? null : '请填写空间名称'),
        },
      ],
      confirmText: '创建',
      onSubmit: async ({ id, name }) => {
        const sid = (id ?? '').trim();
        await api.createSpace(sid, (name ?? '').trim() || sid);
        const r = await api.listSpaces();
        setSpaces(r.spaces);
        switchSpace(sid);
      },
    });

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
          onChange={(e) => switchSpace(e.target.value)}
          title="项目空间"
        >
          {spaces.map((sp) => (
            <option key={sp.id} value={sp.id}>{sp.name}</option>
          ))}
        </select>
        <button className="sidenav-space-add" onClick={newSpace} title="新建项目空间">+</button>
      </div>
      {modal && <PromptModal req={modal} onClose={() => setModal(null)} />}
    </div>
  );
}
