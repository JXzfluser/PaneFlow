import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useStore } from '../store.js';
import { Icon, type IconName } from './Icon.js';

/** 主导航四项——「设置」按用户要求沉到侧栏最底部，「指南」是顶部第一入口（合并向导）。 */
const ITEMS: { id: 'tasks' | 'orchestrate' | 'runs' | 'projects'; icon: IconName; label: string; title: string }[] = [
  { id: 'tasks', icon: 'pen', label: '任务', title: '任务：一句话描述需求，自动编排并执行' },
  { id: 'orchestrate', icon: 'workflow', label: '编排', title: '编排：步骤清单 / 图形画布' },
  { id: 'runs', icon: 'clock', label: '看板', title: '看板：统计 / 审阅队列 / 五列进度板（清单模式查历史细节）' },
  { id: 'projects', icon: 'folder', label: '项目', title: '项目：总览 / 切换 / 新建（原底部下拉已升格为视图）' },
];

/**
 * v18-UI 侧栏 v3（对标 vibex + 用户返工）：
 *  · 版本号以脚注式小字缀在 /paneflow 行内（略微下沉的基线，不占新行）；
 *  · 「指南」升为列表第一入口（指南内可直接发起 30 秒向导——指南与向导合并，指南是门）；
 *  · 「设置」沉到侧栏最底部（高频导航只留 任务/编排/看板/项目）；
 *  · 底栏只留主题切换与连接状态行。
 */
export function SideNav() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const space = useStore((s) => s.space);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
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
  const status = !wsOk
    ? { cls: 'bad', text: '连接断开' }
    : herdrOk === false
      ? { cls: 'warn', text: 'herdr 离线' }
      : { cls: 'ok', text: '连接正常' };

  return (
    <div className="sidenav">
      <div className="sidenav-head">
        <div className="sidenav-brandrow">
          <img className="sidenav-brand" src="/icon.svg" alt="PaneFlow" title="PaneFlow" />
          <span className="sidenav-wordmark">/paneflow</span>
          {/* 脚注式版本号：同一条行盒内略微下沉的小字——在字标下面，但不是换行 */}
          <span className="sidenav-ver">v{__PF_VERSION__}</span>
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
        <button className="sidenav-item" title="使用指南：三步跑通 + 完整教程，也可从这里发起 30 秒建项目向导" onClick={() => setGuideOpen(true)}>
          <span className="sidenav-icon">
            <Icon name="book" size={16} />
          </span>
          <span className="sidenav-label">指南</span>
        </button>
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
      {/* v18-UI v5：底部收成一行三个图标——设置 / 主题 / 连接状态（悬停看详情）。
          三行文字压成三枚图标，侧栏底部不再占竖向空间；「设置沉底」语义不变。 */}
      <div className="sidenav-foot">
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
