import { useEffect, useState } from 'react';
import { fetchJson } from '../api.js';
import { useStore } from '../store.js';
import { ProjectProfileEditor } from './ProjectProfileEditor.jsx';
import { EnvRegister } from './EnvRegister.jsx';
import { projectCardFacts, sortProjectsCurrentFirst, type ProjectLite } from '../project-cards.js';

/** v10-V/W 项目视图：项目是一等公民——卡片墙总览 + 就地展开的档案面板（主从布局）。
 *  档案（主仓/约定/班底/钉档/Agent 选择）已从设置页迁入这里；「编辑档案」先把该项目
 *  切为当前（试跑/下发等上下文跟当前项目走，D4），再展开面板。
 *  v18-UI 建项目入口归一：「＋ 新建项目」即 30 秒向导（此前页面顶栏并排两个建项目流
 *  ——向导 vs 旧式手填表单弹窗，互相竞争；指南内侧另有同一向导入口）。 */
export function ProjectsView() {
  const log = useStore((s) => s.log);
  const space = useStore((s) => s.space);
  const switchSpace = useStore((s) => s.switchSpace);
  const [list, setList] = useState<ProjectLite[]>([]);
  const [editing, setEditing] = useState(false);
  const [envWizard, setEnvWizard] = useState(false);

  const load = () =>
    fetchJson<{ spaces: ProjectLite[] }>('GET', '/api/spaces')
      .then((r) => setList(r.spaces))
      .catch((e: Error) => log('error', `读取项目列表失败：${e.message}`));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const newProject = () => useStore.getState().setPwOpen(true);

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
        <div className="projects-head-actions">
          <button onClick={() => setEnvWizard(true)} title="从本机目录探测并登记到当前项目">
            🔍 发现环境并登记
          </button>
          <button className="primary" onClick={newProject} title="起名 → 扫描登记 → 装班底，一条线走完">
            + 新建项目
          </button>
        </div>
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

      {envWizard && (
        <EnvRegister
          spaceId={space}
          onClose={() => setEnvWizard(false)}
          onRegistered={() => { void load(); }}
        />
      )}
    </div>
  );
}
