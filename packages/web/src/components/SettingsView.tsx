import { useEffect, useState } from 'react';
import { api, getSpace } from '../api.js';
import { useStore } from '../store.js';
interface SpaceProfile {
  id: string;
  name: string;
  createdAt: string;
  rootCwd?: string;
  description?: string;
}

/** 设置视图（B8 骨架 + B10 预置）：空间管理 / 项目档案 / 出站通知 / 环境。 */
export function SettingsView() {
  const log = useStore((s) => s.log);
  const spaceId = getSpace();
  const [profile, setProfile] = useState<SpaceProfile | null>(null);
  const [notify, setNotify] = useState<{ feishuWebhook: string; notifyEvents?: string[] }>({ feishuWebhook: '' });
  const [env, setEnv] = useState<{ herdrOk: boolean; herdrVersion: string | null; env: { agentsInstalled: string[] } } | null>(null);

  useEffect(() => {
    if (spaceId !== 'default') {
      void fetch(`/api/spaces/${encodeURIComponent(spaceId)}`)
        .then((r) => r.json())
        .then((p) => setProfile(p as SpaceProfile));
    }
    void fetch('/api/notify/settings')
      .then((r) => r.json())
      .then((s) => setNotify({ feishuWebhook: s.feishuWebhook ?? '', notifyEvents: s.notifyEvents }));
    void api.health().then(setEnv);
  }, [spaceId]);

  const saveProfile = async () => {
    if (!profile) return;
    try {
      await fetch(`/api/spaces/${encodeURIComponent(spaceId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootCwd: profile.rootCwd, description: profile.description }),
      });
      log('info', '项目档案已保存');
    } catch (e) {
      log('error', `保存失败：${(e as Error).message}`);
    }
  };

  const saveNotify = async () => {
    try {
      await fetch('/api/notify/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(notify.feishuWebhook && !notify.feishuWebhook.startsWith('(') ? { feishuWebhook: notify.feishuWebhook } : {}),
          notifyEvents: notify.notifyEvents ?? ['blocked', 'completed', 'failed'],
        }),
      }).then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
      });
      log('info', '通知设置已保存');
    } catch (e) {
      log('error', `保存失败：${(e as Error).message}`);
    }
  };

  const events = ['blocked', 'completed', 'failed'];
  const activeEvents = notify.notifyEvents ?? ['blocked', 'completed', 'failed'];

  return (
    <div className="settings-view">
      <div className="settings-card">
        <h3>项目档案（当前空间：{spaceId}）</h3>
        {spaceId === 'default' ? (
          <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>
            默认空间用于快速体验。建议在左侧「+」新建一个项目空间（如 demo），再配置主仓根目录与约定文档。
          </p>
        ) : (
          <>
            <label>主仓根目录（仓库/文档/技能发现的基准路径）</label>
            <input
              value={profile?.rootCwd ?? ''}
              onChange={(e) => setProfile((p) => (p ? { ...p, rootCwd: e.target.value } : p))}
              placeholder="/home/user/work/my-project"
            />
            <label>描述</label>
            <input
              value={profile?.description ?? ''}
              onChange={(e) => setProfile((p) => (p ? { ...p, description: e.target.value } : p))}
              placeholder="一句话说明这个项目"
            />
            <button onClick={() => void saveProfile()}>保存档案</button>
          </>
        )}
      </div>

      <div className="settings-card">
        <h3>出站通知（飞书 webhook）</h3>
        <label>机器人 webhook URL（留空 = 关闭；仅支持飞书开放平台域名）</label>
        <input
          value={notify.feishuWebhook}
          onChange={(e) => setNotify((n) => ({ ...n, feishuWebhook: e.target.value }))}
          placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/…"
        />
        <div style={{ display: 'flex', gap: 12, margin: '8px 0' }}>
          {events.map((ev) => (
            <label key={ev} style={{ fontSize: 12, color: 'var(--text-dim)' }}>
              <input
                type="checkbox"
                checked={activeEvents.includes(ev)}
                onChange={(e) =>
                  setNotify((n) => ({
                    ...n,
                    notifyEvents: e.target.checked
                      ? [...(n.notifyEvents ?? events), ev]
                      : (n.notifyEvents ?? events).filter((x) => x !== ev),
                  }))
                }
              />{' '}
              {ev === 'blocked' ? '等待审批' : ev === 'completed' ? '完成' : '失败'}
            </label>
          ))}
        </div>
        <button onClick={() => void saveNotify()}>保存通知设置</button>
      </div>

      <div className="settings-card">
        <h3>环境</h3>
        {env && (
          <p style={{ fontSize: 12, color: 'var(--text-dim)' }}>
            Herdr：{env.herdrOk ? `已连接 ${env.herdrVersion ?? ''}` : '未连接'} ·
            已安装 Agent：{env.env.agentsInstalled.join('、') || '无'}
          </p>
        )}
      </div>
    </div>
  );
}
