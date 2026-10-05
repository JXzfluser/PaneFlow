import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.js';
import type { RunRecord } from '@paneflow/shared';
import { Icon, type IconName } from './Icon.js';

/** 主导航五项——「设置」按用户要求沉到侧栏最底部（图标），「能力」按设计稿 IA 契约
 *  升回一级目的地（注册=能力登记+配置聚合）；「指南」是底部工具（合并向导入口）。 */
const ITEMS: {
  id: 'tasks' | 'orchestrate' | 'runs' | 'projects' | 'caps';
  icon: IconName;
  label: string;
  title: string;
}[] = [
  { id: 'tasks', icon: 'pen', label: '任务', title: '任务：一句话描述需求，自动编排并执行' },
  { id: 'orchestrate', icon: 'workflow', label: '编排', title: '编排：步骤清单 / 图形画布' },
  { id: 'runs', icon: 'clock', label: '看板', title: '看板：统计 / 审阅队列 / 五列进度板（清单模式查历史细节）' },
  { id: 'projects', icon: 'folder', label: '项目', title: '项目：总览 / 切换 / 新建（原底部下拉已升格为视图）' },
  { id: 'caps', icon: 'registry', label: '能力', title: '注册中心：能力登记与配置聚合——每类能力说什么/谁在用/还在不在' },
];

/**
 * v18-UI 侧栏 v5（对标 vibex + 用户返工）：
 *  · 版本号以脚注式小字缀在 /paneflow 行内（略微下沉的基线，不占新行）；
 *  · 「指南」升为列表第一入口（指南内可直接发起 30 秒向导——指南与向导合并，指南是门）；
 *  · 中部「最近」小块填住导航与底栏之间的竖向空档（vibex 的侧栏就是会话清单——
 *    空白变信息：当前项目最近 5 条运行，点击直达画布；没有运行就不渲染，绝不造数）；
 *  · 底部一行三图标：设置 / 主题 / 连接状态（悬停看详情）。
 */

/** 运行状态 → 状态点色（形状语言与全站一致，不只靠颜色） */
function runDotClass(run: RunRecord): string {
  if (run.state === 'completed' || run.state === 'completed-with-failures') return 'ok';
  if (run.state === 'failed') return 'err';
  if (run.state === 'running') {
    // 运行中但有节点卡在人工门 = 需要你，红点区别于干活中的黄点
    return Object.values(run.nodes).some((n) => n.state === 'blocked') ? 'err' : 'working';
  }
  return 'idle'; // queued / cancelled / 未知
}

function runTitle(run: RunRecord): string {
  return (
    run.graph.metadata?.description?.trim() ||
    (run.issueId ? `Issue #${run.issueId}` : run.dagName)
  );
}
export function SideNav() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const space = useStore((s) => s.space);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const setGuideOpen = useStore((s) => s.setGuideOpen);
  const wsOk = useStore((s) => s.wsOk);
  const herdrOk = useStore((s) => s.herdrOk);
  const runs = useStore((s) => s.runs);
  const openRun = useStore((s) => s.openRun);
  const [spaceName, setSpaceName] = useState('');
  // v18-UI 侧栏收缩：用户记忆（localStorage）∪ 窄屏自动——rail 一套样式两个触发源
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('pf-nav-collapsed') === '1');
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 900px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  const rail = collapsed || narrow;
  const toggleCollapsed = () => {
    localStorage.setItem('pf-nav-collapsed', collapsed ? '0' : '1');
    setCollapsed(!collapsed);
  };

  useEffect(() => {
    void api
      .listSpaces()
      .then((r) => setSpaceName(r.spaces.find((sp) => sp.id === space)?.name ?? space))
      .catch(() => setSpaceName(space));
  }, [space]);

  // 「最近」的数据源：挂载时拉一次全量运行账（不依赖其他视图是否先挂载过）
  useEffect(() => {
    void api
      .listRuns()
      .then((r) => useStore.getState().mergeRuns(r.runs))
      .catch(() => undefined);
  }, []);

  const recent = Object.values(runs)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 5);

  // 状态行三态（形状语言与全站 ●/○/? 一致，不只靠颜色）：
  // ws 断 = ○ 连接断开；ws 通但 herdr 不可达 = ! herdr 离线；都在 = ● 连接正常
  const status = !wsOk
    ? { cls: 'bad', text: '连接断开' }
    : herdrOk === false
      ? { cls: 'warn', text: 'herdr 离线' }
      : { cls: 'ok', text: '连接正常' };

  return (
    <div className={`sidenav${rail ? ' rail' : ''}`}>
      <div className="sidenav-head">
        <div className="sidenav-brandrow">
          <img className="sidenav-brand" src="/icon.svg" alt="PaneFlow" title="PaneFlow" />
          <span className="sidenav-wordmark">/paneflow</span>
          {/* 脚注式版本号：同一条行盒内略微下沉的小字——在字标下面，但不是换行 */}
          <span className="sidenav-ver">v{__PF_VERSION__}</span>
          {!narrow && (
            <button
              className="sidenav-iconbtn sidenav-toggle"
              title={rail ? '展开侧栏' : '收起侧栏'}
              onClick={toggleCollapsed}
            >
              <Icon name={rail ? 'unfold' : 'fold'} size={13} />
            </button>
          )}
        </div>
        <button
          className="sidenav-space"
          onClick={() => setView('projects')}
          title={`当前项目「${spaceName}」，点击去项目管理`}
        >
          <span className="sidenav-space-dot" />
          <span className="sidenav-space-name">{spaceName || '未命名项目'}</span>
        </button>
      </div>
      <nav className="sidenav-items" aria-label="主导航">
        {ITEMS.map((it) => (
          <button
            key={it.id}
            className={`sidenav-item ${view === it.id ? 'active' : ''}`}
            title={it.title}
            onClick={() => setView(it.id)}
          >
            <span className="sidenav-icon">
              <Icon name={it.icon} size={16} />
            </span>
            <span className="sidenav-label">{it.label}</span>
          </button>
        ))}
      </nav>
      {recent.length > 0 && (
        <div className="sidenav-recent">
          <div className="sidenav-recent-label">最近</div>
          {recent.map((r) => (
            <button
              key={r.runId}
              className="sidenav-run"
              title={`${runTitle(r)} · ${r.state}${r.issueId ? ` · Issue #${r.issueId}` : ''}——点击打开画布`}
              onClick={() => {
                openRun(r.runId);
                setView('orchestrate');
              }}
            >
              <span className={`sidenav-run-dot ${runDotClass(r)}`} />
              <span className="sidenav-run-name">{runTitle(r)}</span>
            </button>
          ))}
        </div>
      )}
      {/* v18-UI v6：底部一行四图标——指南 / 设置 / 主题 / 连接状态。
          指南是动作不是目的地，不再占导航位（导航=纯目的地）；帮助住底部角落是全行业惯例。 */}
      <div className="sidenav-foot">
        <button
          className="sidenav-iconbtn"
          title="使用指南：三步跑通 + 完整教程，也可从这里发起 30 秒建项目向导"
          onClick={() => setGuideOpen(true)}
        >
          <Icon name="book" size={15} />
        </button>
        <button
          className={`sidenav-iconbtn ${view === 'settings' ? 'active' : ''}`}
          title="设置：环境 / 网关 / GitHub / 用量 / 能力注册 / 角色 / 沉淀 / 通道"
          onClick={() => setView('settings')}
        >
          <Icon name="sliders" size={16} />
        </button>
        <button
          className="icon theme-toggle sidenav-iconbtn"
          data-theme={theme}
          onClick={toggleTheme}
          title={theme === 'dark' ? '切到浅色主题' : '切到暗夜主题'}
        >
          {/* 日月两枚常驻，靠 opacity/scale/blur 交叉淡入——表情符硬切换没有过渡语言 */}
          <span className="theme-face theme-sun">
            <Icon name="sun" size={14} />
          </span>
          <span className="theme-face theme-moon">
            <Icon name="moon" size={14} />
          </span>
        </button>
        <span
          className={`sidenav-iconbtn sidenav-statusbtn`}
          title={`连接状态：WS ${wsOk ? '已连接' : '断开'} · herdr ${herdrOk === false ? '不可达' : '正常'}`}
        >
          <span className={`sidenav-status-dot ${status.cls}`} />
        </span>
      </div>
    </div>
  );
}
