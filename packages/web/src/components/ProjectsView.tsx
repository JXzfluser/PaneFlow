import { useEffect, useState } from 'react';
import { fetchJson } from '../api.js';
import { useStore } from '../store.js';
import { PromptModal, type ModalRequest } from './PromptModal.jsx';
import { projectCardFacts, sortProjectsCurrentFirst, type ProjectLite } from '../project-cards.js';

/** v10-V 项目视图：项目从侧栏底部下拉升格为一等视图——卡片墙总览，点卡即切换，
 *  「编辑档案」直达设置的项目档案（非当前项目会先切换再跳转，设置页响应式跟随）。 */
export function ProjectsView() {
  const log = useStore((s) => s.log);
  const space = useStore((s) => s.space);
  const switchSpace = useStore((s) => s.switchSpace);
  const setView = useStore((s) => s.setView);
  const [list, setList] = useState<ProjectLite[]>([]);
  const [modal, setModal] = useState<ModalRequest | null>(null);

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
      message: '模板与运行记录按项目互相隔离。',
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
      },
    });

  const goProfile = (id: string) => {
    if (id !== space) switchSpace(id);
    setView('settings');
  };

  return (
    <div className="projects-view">
      <div className="projects-head">
        <div>
          <h2>项目</h2>
          <p className="settings-hint">
            模板、运行记录与档案按项目互相隔离；点卡片即切换当前项目，「编辑档案」直达设置页。
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
                    goProfile(p.id);
                  }}
                >
                  编辑档案
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {modal && <PromptModal req={modal} onClose={() => setModal(null)} />}
    </div>
  );
}
