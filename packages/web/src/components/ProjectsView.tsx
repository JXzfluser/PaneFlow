import { useEffect, useState } from 'react';
import { fetchJson } from '../api.js';
import { useStore } from '../store.js';
import { PromptModal, type ModalRequest } from './PromptModal.jsx';
import { ProjectProfileEditor } from './ProjectProfileEditor.jsx';
import { projectCardFacts, sortProjectsCurrentFirst, type ProjectLite } from '../project-cards.js';

/** v10-V/W 项目视图：项目是一等公民——卡片墙总览 + 就地展开的档案面板（主从布局）。
 *  档案（主仓/约定/班底/钉档/Agent 选择）已从设置页迁入这里；「编辑档案」先把该项目
 *  切为当前（试跑/下发等上下文跟当前项目走，D4），再展开面板。 */
export function ProjectsView() {
  const log = useStore((s) => s.log);
  const space = useStore((s) => s.space);
  const switchSpace = useStore((s) => s.switchSpace);
  const [list, setList] = useState<ProjectLite[]>([]);
  const [modal, setModal] = useState<ModalRequest | null>(null);
  const [editing, setEditing] = useState(false);

  const load = () =>
    fetchJson<{ spaces: ProjectLite[] }>('GET', '/api/spaces')
      .then((r) => setList(r.spaces))
      .catch((e: Error) => log('error', `读取项目列表失败：${e.message}`));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const newProject = () =>
    setModal({
      title: '新建项目',
      message: '运行记录与档案按项目互相隔离；编排模板全局共享。',
      fields: [
        {
          key: 'id',
          label: '项目 ID',
          placeholder: 'my-project',
          validate: (v) =>
            /^[a-zA-Z0-9_-]{1,32}$/.test(v.trim()) ? null : '只能包含字母 / 数字 / - / _（≤32 字符）',
        },
        {
          key: 'name',
          label: '项目名称',
          placeholder: '我的项目',
          validate: (v, all) => (v.trim() || all.id?.trim() ? null : '请填写项目名称'),
        },
      ],
      confirmText: '创建',
      onSubmit: async ({ id, name }) => {
        const sid = (id ?? '').trim();
        await fetchJson<unknown>('POST', '/api/spaces', { id: sid, name: (name ?? '').trim() || sid });
        await load();
        switchSpace(sid);
        setEditing(true);
      },
    });

  const openProfile = (id: string) => {
    if (id !== space) switchSpace(id);
    setEditing(true);
    requestAnimationFrame(() => document.getElementById('project-profile')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  return (
    <div className="projects-view">
      <div className="projects-head">
        <div>
          <h2>项目</h2>
          <p className="settings-hint">
            运行记录与档案按项目互相隔离，编排模板全局共享；点卡片即切换当前项目，「编辑档案」在下方就地展开档案面板。
          </p>
        </div>
        <button className="primary" onClick={newProject}>
          + 新建项目
        </button>
      </div>

      <div className="project-grid">
        {sortProjectsCurrentFirst(list, space).map((p) => {
          const f = projectCardFacts(p);
          const cur = p.id === space;
          return (
            <div
              key={p.id}
              className={`project-card${cur ? ' current' : ''}`}
              title={cur ? '当前项目' : `点击切换为当前项目：${p.name}`}
              onClick={() => {
                if (!cur) switchSpace(p.id);
              }}
            >
              <div className="project-head">
                <span className="project-avatar" aria-hidden>
                  📁
                </span>
                <div className="project-id">
                  <b>{p.name}</b>
                  <span className="project-meta">
                    {p.id}
                    {p.createdAt ? ` · 建档于 ${p.createdAt.slice(0, 10)}` : ''}
                  </span>
                </div>
                {cur && <span className="project-duty starter">当前在使用</span>}
              </div>
              <p className="project-blurb">{f.blurb}</p>
              <div className="project-facts">
                <span className={`project-fact${f.rootState === 'missing' ? ' warn' : ''}`}>
                  {f.rootState === 'configured' ? '📂 主仓已配' : '⚠️ 主仓未配'}
                </span>
                <span className={`project-fact${f.hasTeam ? '' : ' idle'}`}>{f.teamBadge}</span>
              </div>
              <div className="project-card-foot">
                {cur ? (
                  <span className="settings-hint">就是它了 ✓</span>
                ) : (
                  <button
                    className="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      switchSpace(p.id);
                    }}
                  >
                    切换为当前
                  </button>
                )}
                <button
                  className="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    openProfile(p.id);
                  }}
                >
                  编辑档案
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {editing && (
        <ProjectProfileEditor key={space} projectId={space} onClose={() => setEditing(false)} />
      )}

      {modal && <PromptModal req={modal} onClose={() => setModal(null)} />}
    </div>
  );
}
