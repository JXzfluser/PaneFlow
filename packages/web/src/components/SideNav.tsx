import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.js';
import { Icon, type IconName } from './Icon.js';

const ITEMS: {
  id: 'tasks' | 'orchestrate' | 'runs' | 'projects' | 'settings';
  icon: IconName;
  label: string;
  sub: string;
  title: string;
}[] = [
  { id: 'tasks', icon: 'pen', label: '任务', sub: 'TASKS', title: '任务：一句话描述需求，自动编排并执行' },
  { id: 'orchestrate', icon: 'workflow', label: '编排', sub: 'ORCHESTRATE', title: '编排：步骤清单 / 图形画布' },
  { id: 'runs', icon: 'clock', label: '看板', sub: 'BOARD', title: '看板：统计 / 审阅队列 / 五列进度板（清单模式查历史细节）' },
  { id: 'projects', icon: 'folder', label: '项目', sub: 'PROJECTS', title: '项目：总览 / 切换 / 新建（原底部下拉已升格为视图）' },
  { id: 'settings', icon: 'sliders', label: '设置', sub: 'SETTINGS', title: '设置：环境 / 网关 / GitHub / 用量 / 能力注册 / 角色 / 沉淀 / 通道' },
];

/**
 * v18-UI 侧栏（对标 vibex）：顶部等宽字标、中部圆角卡片导航（图标+中文+等宽英文小注）、
 * 底部工具（主题/指南）与连接状态行——原 56px 图标竖轨升格为 190px 面板。
 * 顶栏随之瘦身：主题/指南/版本迁到这里（v18-UI），顶栏只留页码眉标与视图级操作。
 */
export function SideNav() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const space = useStore((s) => s.space);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const guideOpen = useStore((s) => s.guideOpen);
  const setGuideOpen = useStore((s) => s.setGuideOpen);
  const wsOk = useStore((s) => s.wsOk);
  const herdrOk = useStore((s) => s.herdrOk);
  const [spaceName, setSpaceName] = useState('');

  useEffect(() => {
    void api
      .listSpaces()
      .then((r) => setSpaceName(r.spaces.find((sp) => sp.id === space)?.name ?? space))
      .catch(() => setSpaceName(space));
  }, [space]);

  // 状态行三态（形状语言与全站 ●/○/? 一致，不只靠颜色）：
  // ws 断 = ○ 连接断开；ws 通但 herdr 不可达 = ! herdr 离线；都在 = ● 连接正常
  const status =
    !wsOk
      ? { cls: 'bad', text: '连接断开' }
      : herdrOk === false
        ? { cls: 'warn', text: 'herdr 离线' }
        : { cls: 'ok', text: '连接正常' };

  return (
    <div className="sidenav">
      <div className="sidenav-head">
        <img className="sidenav-brand" src="/icon.svg" alt="PaneFlow" title="PaneFlow" />
        <span className="sidenav-wordmark">/paneflow</span>
      </div>
      <nav className="sidenav-items" aria-label="主导航">
        {ITEMS.map((it) => (
          <button
            key={it.id}
            className={`sidenav-item ${view === it.id ? 'active' : ''}`}
            title={it.id === 'projects' ? `项目：当前「${spaceName}」` : it.title}
            onClick={() => setView(it.id)}
          >
            <span className="sidenav-icon">
              <Icon name={it.icon} size={15} />
            </span>
            <span className="sidenav-text">
              <span className="sidenav-label">{it.label}</span>
              <span className="sidenav-sub">{it.sub}</span>
            </span>
          </button>
        ))}
      </nav>
      <div className="sidenav-foot">
        <button
          className="icon theme-toggle sidenav-tool"
          data-theme={theme}
          onClick={toggleTheme}
          title={theme === 'dark' ? '切到浅色' : '切到暗夜'}
        >
          {/* 日月两枚常驻，靠 opacity/scale/blur 交叉淡入——表情符硬切换没有过渡语言 */}
          <span className="theme-face theme-sun">
            <Icon name="sun" size={14} />
          </span>
          <span className="theme-face theme-moon">
            <Icon name="moon" size={14} />
          </span>
        </button>
        <button
          className={`sidenav-tool sidenav-guide ${guideOpen ? 'on' : ''}`}
          onClick={() => setGuideOpen(true)}
          title="使用指南"
        >
          <Icon name="book" size={14} /> 指南
        </button>
        <div className={`sidenav-status`} title={`WS ${wsOk ? '已连接' : '断开'} · herdr ${herdrOk === false ? '不可达' : '正常'}`}>
          <span className={`sidenav-status-dot ${status.cls}`} />
          <span className="sidenav-status-text">{status.text}</span>
          <span className="sidenav-status-ver">v{__PF_VERSION__}</span>
        </div>
      </div>
    </div>
  );
}
