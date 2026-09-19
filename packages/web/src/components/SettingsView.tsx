import { useEffect, useRef, useState } from 'react';
import { api, fetchJson, type Channel, type ChannelType, type NotifyEvent } from '../api.js';
import { useStore } from '../store.js';

/** 设置页章节：左侧导航 + 右侧分区，避免 6 张卡片平铺到底 */
const SECTIONS: { id: string; label: string; icon: string }[] = [
  { id: 'space', label: '项目档案', icon: '📁' },
  { id: 'channels', label: '通道', icon: '📡' },
  { id: 'roles', label: '角色库', icon: '👤' },
  { id: 'gateway', label: '模型网关', icon: '🌐' },
  { id: 'github', label: 'GitHub 凭据', icon: '🐙' },
  { id: 'env', label: '环境', icon: '🧩' },
];

const CHANNEL_TYPES: { id: ChannelType; label: string; hint: string }[] = [
  {
    id: 'webhook',
    label: '通用 Webhook',
    hint: 'POST 结构化 JSON（event / title / body / runId / dagName / nodeIds），可对接任意系统',
  },
  { id: 'feishu', label: '飞书机器人', hint: '仅支持 open.feishu.cn 与 open.larksuite.com' },
  { id: 'dingtalk', label: '钉钉机器人', hint: '填加签密钥则自动签名；留空需用关键词或 IP 白名单模式' },
];

const EVENT_OPTIONS: { id: NotifyEvent; label: string }[] = [
  { id: 'blocked', label: '等待审批' },
  { id: 'completed', label: '完成' },
  { id: 'failed', label: '失败' },
];

/** 出站通道：把运行事件推送到外部系统（原「飞书 webhook」的通用化，旧配置会自动迁移） */
function ChannelsEditor() {
  const log = useStore((s) => s.log);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [testing, setTesting] = useState('');
  useEffect(() => {
    void api.listChannels().then((r) => setChannels(r.channels)).catch(() => undefined);
  }, []);

  const patch = (id: string, part: Partial<Channel>) =>
    setChannels((cs) => cs.map((c) => (c.id === id ? { ...c, ...part } : c)));

  const add = () =>
    setChannels((cs) => [
      ...cs,
      {
        id: `ch-${Date.now().toString(36)}`,
        type: 'webhook',
        name: `通道 ${cs.length + 1}`,
        enabled: true,
        url: '',
        events: ['blocked', 'completed', 'failed'],
      },
    ]);

  const save = async () => {
    try {
      const r = await api.saveChannels(channels);
      setChannels(r.channels);
      log('info', `已保存 ${r.channels.length} 条通道`);
    } catch (e) {
      log('error', `保存失败：${(e as Error).message}`);
    }
  };

  const test = async (ch: Channel) => {
    setTesting(ch.id);
    try {
      await api.testChannel(ch);
      log('info', `「${ch.name}」测试消息已发出，请到接收端确认`);
    } catch (e) {
      log('error', `测试失败：${(e as Error).message}`);
    } finally {
      setTesting('');
    }
  };

  return (
    <>
      {channels.map((ch) => {
        const meta = CHANNEL_TYPES.find((t) => t.id === ch.type);
        return (
          <div className="channel-card" key={ch.id}>
            <div className="channel-card-head">
              <label className="settings-check" title="停用后不再推送，但保留配置">
                <input
                  type="checkbox"
                  checked={ch.enabled}
                  onChange={(e) => patch(ch.id, { enabled: e.target.checked })}
                />
                启用
              </label>
              <input
                className="channel-name"
                value={ch.name}
                onChange={(e) => patch(ch.id, { name: e.target.value })}
                placeholder="通道名称"
              />
              <select
                value={ch.type}
                onChange={(e) => patch(ch.id, { type: e.target.value as ChannelType })}
                title="通道类型"
              >
                {CHANNEL_TYPES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
              <button
                className="icon danger"
                title="删除通道"
                onClick={() => setChannels((cs) => cs.filter((x) => x.id !== ch.id))}
              >
                🗑
              </button>
            </div>

            <label>接收地址</label>
            <input
              value={ch.url}
              onChange={(e) => patch(ch.id, { url: e.target.value })}
              placeholder={
                ch.type === 'feishu'
                  ? 'https://open.feishu.cn/open-apis/bot/v2/hook/…'
                  : ch.type === 'dingtalk'
                    ? 'https://oapi.dingtalk.com/robot/send?access_token=…'
                    : 'https://your-system.example.com/hooks/paneflow'
              }
            />
            {ch.type === 'dingtalk' && (
              <>
                <label>加签密钥（可选）</label>
                <input
                  type="password"
                  value={ch.secret ?? ''}
                  onChange={(e) => patch(ch.id, { secret: e.target.value })}
                  placeholder="SEC…"
                />
              </>
            )}
            <p className="settings-hint">{meta?.hint}</p>

            <label>订阅事件</label>
            <div className="settings-row wrap">
              {EVENT_OPTIONS.map((ev) => (
                <label key={ev.id} className="settings-check">
                  <input
                    type="checkbox"
                    checked={ch.events.includes(ev.id)}
                    onChange={(e) =>
                      patch(ch.id, {
                        events: e.target.checked
                          ? [...ch.events, ev.id]
                          : ch.events.filter((x) => x !== ev.id),
                      })
                    }
                  />
                  {ev.label}
                </label>
              ))}
            </div>

            <label>消息模板（可选，支持 {'{{title}} {{body}} {{event}} {{runId}}'}）</label>
            <input
              value={ch.template ?? ''}
              onChange={(e) => patch(ch.id, { template: e.target.value || undefined })}
              placeholder="留空则按通道类型使用默认排版"
            />

            <div className="settings-row channel-card-ops">
              <button className="ghost" disabled={testing === ch.id} onClick={() => void test(ch)}>
                {testing === ch.id ? '发送中…' : '📤 测试发送'}
              </button>
            </div>
          </div>
        );
      })}

      {channels.length === 0 && (
        <p className="settings-hint">
          还没有通道。新增一条后，运行的「等待审批 / 完成 / 失败」就会自动推送过去。
        </p>
      )}

      <div className="settings-actions">
        <button className="ghost" onClick={add}>
          + 新增通道
        </button>
        <button className="primary" onClick={() => void save()}>
          保存通道
        </button>
      </div>
    </>
  );
}

/** v10-U2：GET /api/github/cred 带来源视图（token 本体永不出服务端） */
interface GithubCredState {
  tokenConfigured: boolean;
  defaultRepo: string;
  source?: 'stored-pat' | 'gh-cli' | 'none';
  tokenTail?: string;
  ghLoggedIn?: boolean;
}

function GithubCredCard() {
  const log = useStore((s) => s.log);
  const [g, setG] = useState<GithubCredState>({ tokenConfigured: false, defaultRepo: '' });
  const [token, setToken] = useState('');
  const refresh = () =>
    fetchJson<GithubCredState>('GET', '/api/github/cred')
      .then(setG)
      .catch((e: Error) => log('error', `读取 GitHub 凭据状态失败：${e.message}`));
  useEffect(() => {
    void refresh();
  }, []);
  const save = async () => {
    try {
      const d = await fetchJson<{ tokenConfigured: boolean }>('PUT', '/api/github/cred', {
        ...(token ? { token } : {}),
        defaultRepo: g.defaultRepo,
      });
      setG((x) => ({ ...x, tokenConfigured: d.tokenConfigured }));
      log('info', 'GitHub 凭据已保存（新启动的 Agent Pane 生效）');
      void refresh();
    } catch (e) {
      log('error', `保存失败：${(e as Error).message}`);
    }
  };
  const [writing, setWriting] = useState(false);
  const [importing, setImporting] = useState(false);
  /** U2：解绑=只清本机存的 PAT，gh 登录态兜底还在 */
  const unlink = async () => {
    if (!window.confirm('清除本机存储的 PAT？默认仓库等配置会保留；本机 gh 登录态仍可当兜底凭据。')) return;
    try {
      await fetchJson<{ unlinked: boolean }>('POST', '/api/github/cred/unlink');
      log('info', '已解绑本机存储的 PAT');
      void refresh();
    } catch (e) {
      log('error', `解绑失败：${(e as Error).message}`);
    }
  };
  /** v9-D1：本机 gh 已登录 → 一键把 token 搬进来；拿不到时错误里自带路 A/路 B 指引 */
  const importGh = async () => {
    setImporting(true);
    try {
      const d = await fetchJson<{ imported: boolean; defaultRepo: string }>('POST', '/api/github/cred/import-gh');
      setG((x) => ({ tokenConfigured: true, defaultRepo: x.defaultRepo || d.defaultRepo }));
      log('info', '已从本机 gh CLI 导入 token（新启动的 Agent Pane 生效）');
    } catch (e) {
      log('error', `gh 导入失败：${(e as Error).message}`);
    } finally {
      setImporting(false);
    }
  };
  /** M4：一键回写接单模板（「验收标准」锚点与服务端机检同源），409 时二次确认覆盖 */
  const writeIntake = async (overwrite = false) => {
    setWriting(true);
    try {
      const d = await fetchJson<{ written: boolean; updated?: boolean; path: string }>(
        'POST',
        '/api/github/intake-template',
        overwrite ? { overwrite: true } : undefined,
      );
      log(
        'info',
        d.written
          ? `✅ 接单模板已${d.updated ? '覆盖' : '写入'}：${d.path}（新建 Issue 时可选「PaneFlow 接单单」）`
          : `接单模板已是最新（${d.path}），无需改动`,
      );
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('overwrite')) {
        if (window.confirm(`${msg}\n确定要用 PaneFlow 模板覆盖它吗？`)) {
          await writeIntake(true);
        }
      } else {
        log('error', `接单模板回写失败：${msg}`);
      }
    } finally {
      setWriting(false);
    }
  };
  return (
    <>
      <label>
        GitHub Token {g.tokenConfigured && <span className="inline-ok">（已配置，留空保持不变）</span>}
      </label>
      <p className="settings-hint">
        {g.source === 'stored-pat' && <>来源：本机存储的 PAT · 尾号 {g.tokenTail}{g.ghLoggedIn ? '；gh 登录态可作兜底' : ''}</>}
        {g.source === 'gh-cli' && <>来源：本机 gh 登录态（现取现用，未写盘）。动作侧照常可用；想让它也喂给 Agent Pane 里的 gh，可一键导入落盘。</>}
        {g.source === 'none' && <>来源：无。要么贴一个 PAT，要么本机 gh auth login——登录后无需任何存储即可直连。</>}
      </p>
      <input
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder="github_pat_… / ghp_…"
      />
      <label>默认仓库（owner/name）</label>
      <input
        value={g.defaultRepo}
        onChange={(e) => setG((x) => ({ ...x, defaultRepo: e.target.value }))}
        placeholder="owner/repo"
      />
      <div className="settings-actions">
        <button className="primary" onClick={() => void save()}>
          保存凭据
        </button>
        <button title="读取本机 `gh auth token` 的登录态并存入（gh 未登录会给出两条备选路）" disabled={importing} onClick={() => void importGh()}>
          {importing ? '导入中…' : '🔑 从 gh CLI 一键导入'}
        </button>
        {g.source === 'stored-pat' && (
          <button className="ghost" title="只清本机存的 PAT（默认仓库保留；gh 登录态兜底不受影响）" onClick={() => void unlink()}>
            🔓 解绑本机存储
          </button>
        )}
        <button
          disabled={writing || !(g.tokenConfigured || g.source === 'gh-cli')}
          title={
            g.tokenConfigured || g.source === 'gh-cli'
              ? '向默认仓库写入 .github/ISSUE_TEMPLATE 接单模板（验收标准小节可被 PaneFlow 机检立约）'
              : '先配好凭据（存 PAT 或本机 gh 登录）与默认仓库'
          }
          onClick={() => void writeIntake()}
        >
          {writing ? '回写中…' : '📋 回写接单模板 → 默认仓库'}
        </button>
      </div>
    </>
  );
}

/** v9-D2 网关档视图（服务端只回掩码后的 key 状态） */
interface GatewayProfileView {
  id: string;
  name: string;
  baseUrl: string;
  freeModel?: string;
  enabled?: boolean;
  isCurrent: boolean;
  keyConfigured: boolean;
}
interface GatewayGet {
  baseUrl: string;
  freeModel: string;
  enabled: boolean;
  keyConfigured: boolean;
  profiles: GatewayProfileView[];
  current: string | null;
}
/** v9-D3 导入预览候选（密钥只回尾 4 位） */
interface SwitchCandidate {
  name: string;
  baseUrl: string;
  keyTail: string;
  freeModel?: string;
}

function GatewayCard() {
  const log = useStore((s) => s.log);
  const [g, setG] = useState({ baseUrl: '', freeModel: '', enabled: false, keyConfigured: false });
  const [profiles, setProfiles] = useState<GatewayProfileView[]>([]);
  const [apiKey, setApiKey] = useState('');
  const [testing, setTesting] = useState<string>('');
  const [newName, setNewName] = useState('');
  const [swPath, setSwPath] = useState('');
  const [swCandidates, setSwCandidates] = useState<SwitchCandidate[] | null>(null);
  const [swPicked, setSwPicked] = useState<string[]>([]);
  type GatewayTestResult = { ok: boolean; models?: number; error?: string; chatOk?: boolean; chatError?: string };
  const runTest = async (): Promise<void> => {
    setTesting('探测中…');
    const r = await fetchJson<GatewayTestResult>('POST', '/api/gateway/test').catch(
      (e: Error): GatewayTestResult => ({ ok: false, error: e.message }),
    );
    // 列模型 ≠ 能对话：只有真实 chat completion 通过才算「可用」
    setTesting(
      !r.ok
        ? `✗ ${r.error ?? '失败'}`
        : r.chatOk
          ? `✓ 已连通 · ${r.models} 个模型 · 对话验证通过`
          : `⚠ 能列模型但对话失败：${r.chatError ?? '原因未知'}（展开「免费档模型」换个 id）`,
    );
  };
  const refresh = async (): Promise<GatewayGet> => {
    const cfg = await fetchJson<GatewayGet>('GET', '/api/gateway');
    setG(cfg);
    setProfiles(cfg.profiles ?? []);
    return cfg;
  };
  useEffect(() => {
    void refresh()
      .then((cfg) => {
        // 开着网关进设置页就自动探测一次——结论直接摆脸上，不用用户找按钮
        if (cfg.enabled && cfg.keyConfigured && cfg.baseUrl) void runTest();
      })
      .catch((e: Error) => log('error', `读取网关配置失败：${e.message}`));
  }, []);
  const save = async () => {
    try {
      await fetchJson<{ saved: boolean }>('PUT', '/api/gateway', {
        baseUrl: g.baseUrl,
        // 免费模型留空时给个能跑的缺省——pi 的 --model 与 claude 的 ANTHROPIC_MODEL 都吃这个
        freeModel: g.freeModel.trim() || 'auto/best-free',
        enabled: g.enabled,
        ...(apiKey ? { apiKey } : {}),
      });
      setG((x) => ({ ...x, keyConfigured: true }));
      setApiKey('');
      log('info', '模型网关已保存（新启动的 Agent Pane 生效）');
      await refresh();
      await runTest();
    } catch (e) {
      log('error', `保存失败：${(e as Error).message}`);
    }
  };
  /** D2：把上方表单当前内容另存为一档新网关（不动生效档） */
  const saveAsNew = async () => {
    try {
      await fetchJson<{ ok: boolean; id: string }>('POST', '/api/gateway/profile', {
        name: newName,
        baseUrl: g.baseUrl,
        apiKey,
        freeModel: g.freeModel.trim() || undefined,
        enabled: g.enabled,
      });
      setNewName('');
      setApiKey('');
      await refresh();
      log('info', `新档「${newName}」已入列（未切生效档；要启用点它的「设为生效」）`);
    } catch (e) {
      log('error', `另存新档失败：${(e as Error).message}`);
    }
  };
  const switchTo = async (p: GatewayProfileView) => {
    try {
      await fetchJson<{ ok: boolean }>('PUT', '/api/gateway/current', { id: p.id });
      await refresh();
      log('info', `生效档已切到「${p.name}」（pi 的 paneflow-gw 同步跟随）`);
    } catch (e) {
      log('error', `切档失败：${(e as Error).message}`);
    }
  };
  const removeProfile = async (p: GatewayProfileView) => {
    if (!window.confirm(`删除网关档「${p.name}」？密钥与地址会一并从本地移除。`)) return;
    try {
      await fetchJson<{ ok: boolean }>('DELETE', `/api/gateway/profile/${encodeURIComponent(p.id)}`);
      await refresh();
      log('info', `已删除档「${p.name}」`);
    } catch (e) {
      log('error', `删档失败：${(e as Error).message}`);
    }
  };
  /** D3：preview 只回掩码候选；确认勾选后才落盘 */
  const probeImport = async () => {
    try {
      const d = await fetchJson<{ candidates: SwitchCandidate[] }>('POST', '/api/gateway/import', { path: swPath });
      setSwCandidates(d.candidates);
      setSwPicked(d.candidates.map((c) => c.name));
    } catch (e) {
      setSwCandidates(null);
      log('error', `识别失败：${(e as Error).message}`);
    }
  };
  const applyImport = async () => {
    try {
      const d = await fetchJson<{ imported: string[] }>('POST', '/api/gateway/import', { path: swPath, names: swPicked });
      setSwCandidates(null);
      setSwPath('');
      await refresh();
      log('info', `已导入 ${d.imported.length} 档：${d.imported.join('、')}（都是新档，未自动切生效档）`);
    } catch (e) {
      log('error', `导入失败：${(e as Error).message}`);
    }
  };
  return (
    <>
      <div className="settings-row">
        <input
          style={{ flex: 2, minWidth: 220 }}
          value={g.baseUrl}
          onChange={(e) => setG((x) => ({ ...x, baseUrl: e.target.value }))}
          placeholder="网关地址，如 http://127.0.0.1:20128（带不带 /v1 都行）"
          aria-label="网关地址"
        />
        <input
          style={{ flex: 1, minWidth: 140 }}
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={g.keyConfigured ? 'Key 已存 ✓（留空不改）' : 'API Key sk-…'}
          aria-label="API Key"
        />
      </div>
      <div className="gateway-row">
        <label className="settings-check" title="注入 OPENAI_*/ANTHROPIC_* 到每个 Agent Pane；claude 经 --settings、pi 经 --provider openai 强制走网关">
          <input type="checkbox" checked={g.enabled} onChange={(e) => setG((x) => ({ ...x, enabled: e.target.checked }))} />
          启用：所有 Agent 统一走网关模型
        </label>
        <details className="settings-more">
          <summary>免费档模型 id：{g.freeModel || 'auto/best-free（缺省）'}</summary>
          <input
            value={g.freeModel}
            onChange={(e) => setG((x) => ({ ...x, freeModel: e.target.value }))}
            placeholder="auto/best-free"
          />
        </details>
      </div>
      <div className="settings-actions">
        {testing && <span className={testing.startsWith('✓') ? 'inline-ok' : 'settings-action-note'}>{testing}</span>}
        <button className="primary" onClick={() => void save()}>
          💾 保存并测试
        </button>
      </div>
      {/* v9-D2 多网关档：上面表单编辑的是生效档；并存其他网关在下方列表里切/删 */}
      <div className="gw-profiles">
        <label>网关档位（{profiles.length} 档 · 上方表单保存 = 改生效档「{profiles.find((p) => p.isCurrent)?.name ?? '—'}」）</label>
        {profiles.map((p) => (
          <div className="gw-profile" key={p.id}>
            <b className={p.isCurrent ? 'gw-cur' : ''}>{p.isCurrent ? '● ' : '○ '}{p.name}</b>
            <span className="settings-hint">
              {p.baseUrl || '（无地址）'} · {p.keyConfigured ? 'key ✓' : '无 key'}
              {p.freeModel ? ` · ${p.freeModel}` : ''}
              {p.enabled === false ? ' · 已停用' : ''}
            </span>
            {!p.isCurrent && (
              <button className="sm" onClick={() => void switchTo(p)}>设为生效</button>
            )}
            {profiles.length > 1 && (
              <button className="sm ghost" title="删除此档" onClick={() => void removeProfile(p)}>✕</button>
            )}
          </div>
        ))}
        <div className="settings-row">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="新档名，如「公司网关」"
            aria-label="新档名"
          />
          <button
            disabled={!newName.trim()}
            title="把上方表单里的地址/Key/模型另存为一档新网关（需要填 Key）"
            onClick={() => void saveAsNew()}
          >
            ＋ 另存为新档
          </button>
        </div>
      </div>
      <details className="settings-more">
        <summary>📥 从外部配置导入网关（cc Switch / 同类 switcher 的 JSON）</summary>
        <div className="settings-row">
          <input
            value={swPath}
            onChange={(e) => setSwPath(e.target.value)}
            placeholder="配置文件绝对路径，如 /Users/you/.cc-switch/config.json"
            aria-label="外部配置文件路径"
          />
          <button disabled={!swPath.trim()} onClick={() => void probeImport()}>🔍 识别</button>
        </div>
        {swCandidates && (
          <>
            <p className="settings-hint">认出 {swCandidates.length} 个 provider（密钥只显示尾 4 位；勾选后导入为新增档）：</p>
            {swCandidates.map((c) => (
              <label key={c.name} className="settings-check">
                <input
                  type="checkbox"
                  checked={swPicked.includes(c.name)}
                  onChange={(e) =>
                    setSwPicked((xs) => (e.target.checked ? [...xs, c.name] : xs.filter((x) => x !== c.name)))
                  }
                />
                {c.name} · {c.baseUrl} · key…**{c.keyTail}{c.freeModel ? ` · ${c.freeModel}` : ''}
              </label>
            ))}
            <div className="settings-actions">
              <button className="primary" disabled={!swPicked.length} onClick={() => void applyImport()}>
                ⬇ 导入勾选（{swPicked.length}）
              </button>
            </div>
          </>
        )}
      </details>
    </>
  );
}

/** v9-D2 空间钉档：本项目 Agent 固定用某档网关（全局切档不受影响）；「跟随全局」= current */
function GatewayPinField({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const log = useStore((s) => s.log);
  const [profiles, setProfiles] = useState<GatewayProfileView[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    void fetchJson<GatewayGet>('GET', '/api/gateway')
      .then((d) => {
        setProfiles(d.profiles ?? []);
        setCurrent(d.current);
      })
      .catch((e: Error) => log('error', `读取网关档位失败：${e.message}`));
  }, []);
  const dangling = Boolean(value) && !profiles.some((p) => p.id === value);
  return (
    <>
      <label title="本项目所有 Agent 固定用这一档网关，不受全局切档影响；钉的档被删了会自动回落全局生效档">
        网关档位（本项目钉档）
      </label>
      <select
        value={dangling ? '__dangling__' : value}
        onChange={(e) => onChange(e.target.value === '__dangling__' ? '' : e.target.value)}
        aria-label="本项目钉的网关档"
      >
        <option value="">
          跟随全局生效档{current ? `（${profiles.find((p) => p.id === current)?.name ?? ''}）` : ''}
        </option>
        {profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.isCurrent ? '（全局生效）' : ''}
          </option>
        ))}
        {dangling && <option value="__dangling__">{value}（已删除，暂跟随全局）</option>}
      </select>
    </>
  );
}

interface Role {
  id: string;
  name: string;
  agentKind?: string;
  prePrompt?: string;
  env?: Record<string, string>;
}

/** v10-U1 首发阵容链：标准五连打头，按规划→实现→评审→验收→沉淀排 */
const BOT_ORDER = ['std-planner', 'std-implementer', 'std-reviewer', 'std-verifier', 'std-curator'];
const BOT_ICONS: Record<string, string> = {
  'std-planner': '🧭',
  'std-implementer': '⚙️',
  'std-reviewer': '🔍',
  'std-verifier': '✅',
  'std-curator': '📚',
};
type RoleUsage = { spaceId: string; name: string; alias?: string }[];

function RolesEditor() {
  const log = useStore((s) => s.log);
  const [roles, setRoles] = useState<Role[]>([]);
  const [usage, setUsage] = useState<Record<string, RoleUsage>>({});
  const [agentKinds, setAgentKinds] = useState<string[]>([]);
  useEffect(() => {
    void fetchJson<{ roles?: Role[] }>('GET', '/api/roles')
      .then((d) => setRoles(d.roles ?? []))
      .catch((e: Error) => log('error', `读取角色库失败：${e.message}`));
    // 部署数只是角标信息：拉不到不报错，阵容照画
    void fetchJson<{ usage?: Record<string, RoleUsage> }>('GET', '/api/roles/usage')
      .then((d) => setUsage(d.usage ?? {}))
      .catch(() => undefined);
    void api.health().then((h) => setAgentKinds(h.agentKinds));
  }, []);
  const save = (next: Role[]) => {
    setRoles(next);
    void fetchJson<unknown>('PUT', '/api/roles', { roles: next })
      .then(() => log('info', '角色库已保存'))
      .catch((e: Error) => log('error', e.message));
  };
  const patch = (id: string, part: Partial<Role>) =>
    setRoles((rs) => rs.map((r) => (r.id === id ? { ...r, ...part } : r)));
  // 稳定排序：标准五连按链序打头，其余按入库顺序
  const sorted = [...roles].sort((a, b) => {
    const ia = BOT_ORDER.indexOf(a.id);
    const ib = BOT_ORDER.indexOf(b.id);
    return (ia < 0 ? 100 : ia) - (ib < 0 ? 100 : ib);
  });
  const ghosts = Object.entries(usage).filter(([id]) => !roles.some((r) => r.id === id));
  return (
    <>
      {roles.length === 0 && (
        <p className="settings-hint">
          班底还是空的。到「项目档案」里点「一键装填标准五连」，五个首发 bot（规划/实现/评审/验收/沉淀）就会到位。
        </p>
      )}
      <div className="role-roster">
        {sorted.map((r) => {
          const on = usage[r.id] ?? [];
          const persona = (r.prePrompt ?? '')
            .split('\n')
            .map((l) => l.trim())
            .find(Boolean);
          return (
            <div className="bot-card" key={r.id}>
              <div className="bot-head">
                <span className="bot-avatar" aria-hidden>
                  {BOT_ICONS[r.id] ?? '🤖'}
                </span>
                <div className="bot-id">
                  <strong>{r.name}</strong>
                  <span className="bot-meta">{r.agentKind ? `⚡ ${r.agentKind}` : '⚡ 默认 Agent'}</span>
                </div>
                <span
                  className={on.length ? `bot-duty${BOT_ORDER.includes(r.id) ? ' starter' : ''}` : 'bot-duty idle'}
                  title={on.map((p) => (p.alias ? `${p.name} · ${p.alias}` : p.name)).join('、')}
                >
                  {on.length ? `已部署 ${on.length} 个项目` : '待命'}
                </span>
              </div>
              <p className="bot-persona">{persona ? `${persona.slice(0, 64)}${persona.length > 64 ? '…' : ''}` : '还没写人设——展开下方卡背补上'}</p>
              <details className="bot-edit">
                <summary>编辑这张卡</summary>
                <input
                  value={r.name}
                  onChange={(e) => patch(r.id, { name: e.target.value })}
                  placeholder="角色名"
                  className="role-name"
                />
                <select
                  value={r.agentKind ?? ''}
                  onChange={(e) => patch(r.id, { agentKind: e.target.value || undefined })}
                  title="该角色默认使用的 Agent 类型"
                >
                  <option value="">（默认 Agent）</option>
                  {agentKinds.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
                <textarea
                  value={r.prePrompt ?? ''}
                  onChange={(e) => patch(r.id, { prePrompt: e.target.value })}
                  placeholder="角色人设（渲染在节点指令之前），如：你是后端开发工程师，遵守团队分支与提交规范…"
                />
                <label>环境变量（每行 key=值；典型：模型网关地址，节点级可覆盖）</label>
                <input
                  value={Object.entries(r.env ?? {})
                    .map(([k, v]) => `${k}=${v}`)
                    .join('  ')}
                  onChange={(e) => {
                    const env: Record<string, string> = {};
                    for (const line of e.target.value.split(/\s+/)) {
                      const idx = line.indexOf('=');
                      if (idx > 0) env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
                    }
                    patch(r.id, { env: Object.keys(env).length ? env : undefined });
                  }}
                  placeholder="ANTHROPIC_BASE_URL=http://127.0.0.1:4000"
                />
                <div className="bot-card-foot">
                  <button
                    className="ghost"
                    onClick={() => save(roles.filter((x) => x.id !== r.id))}
                    title="从角色库删除（各项目班底里的引用会悬空，界面会标出）"
                  >
                    🗑 删除角色
                  </button>
                </div>
              </details>
            </div>
          );
        })}
      </div>
      {ghosts.length > 0 && (
        <p className="bot-ghosts">
          ⚠️ 班底里还引用着已不在库的角色：
          {ghosts.map(([id, ps]) => ` ${id}（${ps.map((p) => p.name).join('、')}）`).join('；')}
        </p>
      )}
      <button
        className="ghost"
        onClick={() => save([...roles, { id: `role-${Date.now().toString(36)}`, name: `角色 ${roles.length + 1}` }])}
      >
        + 新增角色
      </button>
    </>
  );
}

interface SpaceProfile {
  id: string;
  name: string;
  createdAt: string;
  rootCwd?: string;
  description?: string;
  conventionFiles?: string[];
  skills?: string[];
  repos?: string[];
  defaultAgentKind?: string;
  agentOverride?: boolean;
  experienceInjection?: boolean;
  team?: TeamMember[];
  gatewayProfile?: string;
}

/** v9-B1/B3 班底成员：roleId 指向全局角色库，alias 是本项目昵称 */
interface TeamMember {
  roleId: string;
  alias?: string;
  note?: string;
}

/** v9-B3 班底卡片：列成员 / 选角色 / 改昵称 / 移除 / 单人试跑 / 一键装填标准五连 */
function TeamEditor({
  team,
  onChange,
  rootCwd,
}: {
  team: TeamMember[];
  onChange: (t: TeamMember[]) => void;
  rootCwd: string | undefined;
}) {
  const log = useStore((s) => s.log);
  const spaceId = useStore((s) => s.space);
  const [roles, setRoles] = useState<Role[]>([]);
  const [busy, setBusy] = useState(false);

  const loadRoles = () =>
    fetchJson<{ roles?: Role[] }>('GET', '/api/roles')
      .then((d) => setRoles(d.roles ?? []))
      .catch((e: Error) => log('error', `读取角色库失败：${e.message}`));
  useEffect(() => {
    void loadRoles();
  }, []);

  const patch = (idx: number, part: Partial<TeamMember>) =>
    onChange(team.map((m, i) => (i === idx ? { ...m, ...part } : m)));
  const remove = (idx: number) => onChange(team.filter((_, i) => i !== idx));

  const installStandard = async () => {
    setBusy(true);
    try {
      const r = await fetchJson<{ profile: { team?: TeamMember[] } }>(
        'POST',
        `/api/spaces/${encodeURIComponent(spaceId)}/team/standard`,
      );
      onChange(r.profile.team ?? []);
      await loadRoles(); // 标准角色可能刚补进全局库
      log('info', '标准五连已装填（规划/实现/评审/验收/沉淀）——记得点「保存档案」');
    } catch (e) {
      log('error', `装填失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  /** B3 单人试跑：start→agent(role)→end 的最小图，走现链路 */
  const tryout = async (m: TeamMember) => {
    if (!m.roleId) {
      log('error', '这一位还没选角色');
      return;
    }
    if (!rootCwd?.trim()) {
      log('error', '单人试跑需要工作目录：先在上方填主仓根');
      return;
    }
    const name = m.alias || roles.find((r) => r.id === m.roleId)?.name || m.roleId;
    const now = new Date().toISOString();
    try {
      const r = await api.startRun(
        {
          version: 1,
          name: `trial-${m.roleId}-${Date.now().toString(36)}`,
          nodes: [
            { id: 'start', type: 'start', label: '开始', config: {} },
            {
              id: 'run',
              type: 'agent',
              label: `试跑 · ${name}`,
              config: {
                role: m.roleId,
                prompt: `这是成员「${name}」的单人试跑：请用 3-5 行自我介绍（专长、适合的活、交付习惯），不要读取或改动任何文件。`,
              },
            },
            { id: 'end', type: 'end', label: '结束', config: {} },
          ],
          edges: [
            { id: 't1', source: 'start', target: 'run' },
            { id: 't2', source: 'run', target: 'end' },
          ],
          metadata: { createdAt: now, updatedAt: now, description: `单人试跑：${name}` },
        },
        rootCwd.trim(),
      );
      log('info', `已发起「${name}」的试跑（${r.runId}）——去「运 · 运行」页看结果`);
    } catch (e) {
      log('error', `试跑失败：${(e as Error).message}`);
    }
  };

  return (
    <>
      <label title="班底=这个项目固定用的一组成员（取自全局角色库）；智能下发只会从班底点人">班底（{team.length} 人）</label>
      {team.length === 0 && (
        <p className="settings-hint">还没有班底：下发按默认班底跑。可一键装填「标准五连」（规划/实现/评审/验收/沉淀）。</p>
      )}
      {team.map((m, i) => {
        const dangling = m.roleId !== '' && !roles.some((r) => r.id === m.roleId);
        return (
          <div className="team-row" key={i}>
            <select
              value={m.roleId}
              onChange={(e) => patch(i, { roleId: e.target.value })}
              title="班底成员对应的全局角色"
            >
              <option value="">（选角色）</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
              {dangling && <option value={m.roleId}>{m.roleId}（库里已删）</option>}
            </select>
            <input
              value={m.alias ?? ''}
              onChange={(e) => patch(i, { alias: e.target.value || undefined })}
              placeholder="昵称（可选）"
              className="team-alias"
            />
            <input
              value={m.note ?? ''}
              onChange={(e) => patch(i, { note: e.target.value || undefined })}
              placeholder="备注（可选：擅长边界）"
              className="team-note"
            />
            <button className="link" onClick={() => void tryout(m)} title="单节点 run：只让这一位跑一句自我介绍">
              ▶ 试跑
            </button>
            <button className="link" onClick={() => remove(i)} title="移出班底">
              ✕
            </button>
          </div>
        );
      })}
      <div className="team-actions">
        <button onClick={() => onChange([...team, { roleId: '' }])} disabled={team.length >= 16}>
          + 加成员
        </button>
        <button onClick={() => void installStandard()} disabled={busy}>
          🪄 {busy ? '装填中…' : '一键装填标准五连'}
        </button>
      </div>
    </>
  );
}

/** 设置视图：左侧章节导航 + 右侧分区（原为 6 张卡片平铺 + 大量内联样式）。 */
export function SettingsView() {
  const log = useStore((s) => s.log);
  // 响应式读当前项目（D4）：侧栏切换后本页自动跟随刷新
  const spaceId = useStore((s) => s.space);
  const agentKinds = useStore((s) => s.agentKinds);
  const [profile, setProfile] = useState<SpaceProfile | null>(null);
  const [env, setEnv] = useState<{
    herdrOk: boolean;
    herdrVersion: string | null;
    recommendedAgentKind?: string | null;
    gatewayEnabled?: boolean;
    env: { agentsInstalled: string[] };
  } | null>(null);
  const [discover, setDiscover] = useState<{ markdowns: string[]; skills: string[]; repos: string[] } | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [recentRoots, setRecentRoots] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('pf-recent-roots') ?? '[]') as string[]; } catch { return []; }
  });
  const [browseDir, setBrowseDir] = useState<string | null>(null);
  const [browseList, setBrowseList] = useState<string[] | null>(null);
  const [active, setActive] = useState(SECTIONS[0]?.id ?? 'space');
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // AE：默认项目也要能配「项目默认 Agent/统一覆盖」——档案照常读取（表单仅呈现可配项）
    void fetchJson<SpaceProfile>('GET', `/api/spaces/${encodeURIComponent(spaceId)}`)
      .then(setProfile)
      .catch((e: Error) => log('error', `读取项目档案失败：${e.message}`));
    void api.health().then(setEnv);
  }, [spaceId]);

  // 滚动时高亮当前章节
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onScroll = () => {
      let cur = SECTIONS[0]?.id ?? 'space';
      for (const s of SECTIONS) {
        const node = document.getElementById(`sec-${s.id}`);
        if (node && node.getBoundingClientRect().top <= 140) cur = s.id;
      }
      setActive(cur);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  const jump = (id: string) => {
    setActive(id);
    document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const loadBrowse = async (dir: string) => {
    try {
      const d = await fetchJson<{ entries?: string[]; dir?: string }>('GET', `/api/fs/browse?path=${encodeURIComponent(dir)}`);
      setBrowseList(d.entries ?? []);
      setBrowseDir(d.dir ?? dir);
    } catch {
      setBrowseList([]);
    }
  };

  const saveProfile = async () => {
    if (!profile) return;
    try {
      // 全字段回写：PUT 是 merge 语义，漏发的键会保住旧值——勾选过的约定/技能/仓库必须随表单一并发出
      await fetchJson<unknown>('PUT', `/api/spaces/${encodeURIComponent(spaceId)}`, {
        rootCwd: profile.rootCwd,
        description: profile.description,
        conventionFiles: profile.conventionFiles ?? [],
        skills: profile.skills ?? [],
        repos: profile.repos ?? [],
        defaultAgentKind: profile.defaultAgentKind ?? '',
        agentOverride: !!profile.agentOverride,
        experienceInjection: profile.experienceInjection !== false,
        team: profile.team ?? [], // v9-B1：漏发=保住旧班底，但清空必须发得出去
        gatewayProfile: profile.gatewayProfile ?? '', // v9-D2：空串=取消钉档，跟随全局
      });
      if (profile?.rootCwd) {
        const next = [profile.rootCwd, ...recentRoots.filter((x) => x !== profile.rootCwd)].slice(0, 5);
        setRecentRoots(next);
        localStorage.setItem('pf-recent-roots', JSON.stringify(next));
      }
      log('info', '项目档案已保存');
    } catch (e) {
      log('error', `保存失败：${(e as Error).message}`);
    }
  };

  // AE/I2 Agent 选择控件：默认项目档案表单虽精简，这几个必须可配（实机阻塞点）
  const installedKinds = (env?.env.agentsInstalled ?? []).filter((k) => (agentKinds as readonly string[]).includes(k));
  const otherKinds = agentKinds.filter((k) => !installedKinds.includes(k));
  const pickKind = (k: string) =>
    setProfile((p) => (p ? { ...p, defaultAgentKind: k, ...(k ? {} : { agentOverride: false }) } : p));
  const agentControls = (
    <>
      <label title="节点/角色没指定 Agent 类型时用它；智能下发 Planner 也用它。「自动」= 本机已装里挑（pi > opencode > codex > claude）">
        默认 Agent
      </label>
      <div className="agent-chips" role="radiogroup" aria-label="默认 Agent">
        <button
          type="button"
          role="radio"
          aria-checked={!profile?.defaultAgentKind}
          className={`agent-chip${!profile?.defaultAgentKind ? ' on' : ''}`}
          onClick={() => pickKind('')}
        >
          自动{env?.recommendedAgentKind ? ` · ${env.recommendedAgentKind}` : '（检测中…）'}
        </button>
        {installedKinds.map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={profile?.defaultAgentKind === k}
            className={`agent-chip${profile?.defaultAgentKind === k ? ' on' : ''}`}
            onClick={() => pickKind(k)}
          >
            {k}
          </button>
        ))}
      </div>
      {otherKinds.length > 0 && (
        <details className="settings-more">
          <summary>本机未装的 {otherKinds.length} 个 CLI（谨慎选择，点了起不来）</summary>
          <div className="agent-chips">
            {otherKinds.map((k) => (
              <button
                key={k}
                type="button"
                className={`agent-chip dim${profile?.defaultAgentKind === k ? ' on' : ''}`}
                onClick={() => pickKind(k)}
              >
                {k}
              </button>
            ))}
          </div>
        </details>
      )}
      <div className="stack">
        <label
          className="settings-check"
          title="本项目所有 Agent 一律用上面的默认值——包括旧模板里钉死的类型。配合「模型网关」= 启动的 agent 全部统一走网关模型。"
        >
          <input
            type="checkbox"
            disabled={!profile?.defaultAgentKind}
            checked={!!profile?.agentOverride}
            onChange={(e) => setProfile((p) => (p ? { ...p, agentOverride: e.target.checked } : p))}
          />{' '}
          统一覆盖：强制所有节点用「{profile?.defaultAgentKind || '默认'}」
        </label>
        <label
          className="settings-check"
          title="同模板有绿 run 时，其「实填变量+断言清单+成本画像」会自动附进新单首个 Agent 节点的上下文。关掉即恢复纯现场发挥。"
        >
          <input
            type="checkbox"
            checked={profile?.experienceInjection !== false}
            onChange={(e) => setProfile((p) => (p ? { ...p, experienceInjection: e.target.checked } : p))}
          />{' '}
          上次成功跑过的变量/验收/成本，自动喂给下一单
        </label>
      </div>
    </>
  );

  return (
    <div className="settings-view">
      <nav className="settings-nav" aria-label="设置章节">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`settings-nav-item${active === s.id ? ' on' : ''}`}
            onClick={() => jump(s.id)}
          >
            <span className="settings-nav-icon">{s.icon}</span>
            {s.label}
          </button>
        ))}
      </nav>

      <div className="settings-body" ref={bodyRef}>
        <section className="settings-card" id="sec-space">
          <h3>项目档案</h3>
          <p className="settings-hint">当前项目：<b>{spaceId}</b></p>
          {spaceId === 'default' ? (
            <>
              <p className="settings-hint">
                默认项目用于快速体验。建议在左侧「项目」视图新建一个项目（如 demo），再配置主仓根目录与约定文档。
                下面这几项（AE Agent 选择 / I2 经验注入）在默认项目同样可配：
              </p>
              {agentControls}
              <div className="settings-actions">
                <button className="primary" onClick={() => void saveProfile()}>
                  保存档案
                </button>
              </div>
            </>
          ) : (
            <>
              <label>主仓根目录（仓库/文档/技能发现的基准路径）</label>
              <div className="settings-row">
                <input
                  value={profile?.rootCwd ?? ''}
                  onChange={(e) => setProfile((p) => (p ? { ...p, rootCwd: e.target.value } : p))}
                  placeholder="/home/user/work/my-project"
                />
                <button onClick={() => setBrowsing((b) => !b)}>📁 浏览</button>
              </div>
              <div className="settings-row wrap recent-roots">
                <span className="settings-hint">最近：</span>
                {recentRoots.slice(0, 3).map((r) => (
                  <button
                    key={r}
                    className="sm"
                    title={r}
                    onClick={() => setProfile((p) => (p ? { ...p, rootCwd: r } : p))}
                  >
                    {r.split('/').pop() || r}
                  </button>
                ))}
                <span
                  className="settings-dropzone"
                  title="拖拽文件夹到此可填入路径"
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    const item = e.dataTransfer?.items?.[0];
                    const entry = item?.webkitGetAsEntry?.() as { fullPath?: string } | null;
                    if (entry?.fullPath) setProfile((p) => (p ? { ...p, rootCwd: entry.fullPath } : p));
                  }}
                >
                  ⤵ 拖拽
                </span>
              </div>
              {browsing && (
                <div className="settings-listbox settings-browse">
                  <div className="settings-hint">{browseDir || '（父级）'}</div>
                  {(browseList || []).map((d) => (
                    <div
                      key={d}
                      className="settings-browse-item"
                      onClick={() => {
                        setBrowseDir((browseDir || '') + '/' + d);
                        setBrowseList(null);
                        void loadBrowse((browseDir || '') + '/' + d);
                      }}
                    >
                      📁 {d}
                    </div>
                  ))}
                  {browseList === null && <span className="settings-hint">加载中…</span>}
                </div>
              )}
              <button
                className="ghost"
                onClick={() =>
                  void fetchJson<{ error?: string; markdowns?: string[]; skills?: string[]; repos?: string[] }>(
                    'GET',
                    `/api/fs/discover?root=${encodeURIComponent(profile?.rootCwd ?? '')}`,
                  )
                    .then((d) => {
                      if (d.error) {
                        log('error', d.error);
                        return;
                      }
                      setDiscover({ markdowns: d.markdowns ?? [], skills: d.skills ?? [], repos: d.repos ?? [] });
                      // auto-select conventions on first discovery
                      setProfile((p) =>
                        p
                          ? {
                              ...p,
                              conventionFiles: p.conventionFiles ?? (d.markdowns ?? []).filter((f) => /AGENTS|CLAUDE/i.test(f)),
                              skills: p.skills ?? [],
                            }
                          : p,
                      );
                    })
                    .catch((e: Error) => log('error', `发现失败：${e.message}`))
                }
              >
                🔍 发现约定文档与技能
              </button>
              {discover && (
                <div className="settings-discover">
                  <div>
                    <label>约定文档（勾选 = 运行时注入）</label>
                    <div className="settings-listbox">
                      {discover.markdowns.map((f) => (
                        <label key={f} className="settings-check">
                          <input
                            type="checkbox"
                            checked={(profile?.conventionFiles ?? []).includes(f)}
                            onChange={(e) =>
                              setProfile((p) =>
                                p
                                  ? {
                                      ...p,
                                      conventionFiles: e.target.checked
                                        ? [...(p.conventionFiles ?? []), f]
                                        : (p.conventionFiles ?? []).filter((x) => x !== f),
                                    }
                                  : p,
                              )
                            }
                          />
                          {f}
                        </label>
                      ))}
                      {discover.markdowns.length === 0 && <span className="settings-hint">未发现 markdown</span>}
                    </div>
                  </div>
                  <div>
                    <label>仓库（含 .git 的子目录，勾选 = 登记）</label>
                    <div className="settings-listbox">
                      {(discover.repos ?? []).map((r) => (
                        <label key={r} className="settings-check">
                          <input
                            type="checkbox"
                            checked={(profile?.repos ?? []).includes(r)}
                            onChange={(e) =>
                              setProfile((p) =>
                                p
                                  ? { ...p, repos: e.target.checked ? [...(p.repos ?? []), r] : (p.repos ?? []).filter((x) => x !== r) }
                                  : p,
                              )
                            }
                          />
                          {r}
                        </label>
                      ))}
                      {(discover.repos ?? []).length === 0 && <span className="settings-hint">未发现仓库</span>}
                    </div>
                  </div>
                  <div>
                    <label>技能（skills/ 目录）</label>
                    <div className="settings-listbox">
                      {discover.skills.map((f) => (
                        <label key={f} className="settings-check">
                          <input
                            type="checkbox"
                            checked={(profile?.skills ?? []).includes(f)}
                            onChange={(e) =>
                              setProfile((p) =>
                                p
                                  ? { ...p, skills: e.target.checked ? [...(p.skills ?? []), f] : (p.skills ?? []).filter((x) => x !== f) }
                                  : p,
                              )
                            }
                          />
                          {f}
                        </label>
                      ))}
                      {discover.skills.length === 0 && <span className="settings-hint">未发现技能</span>}
                    </div>
                  </div>
                </div>
              )}
              <label>描述</label>
              <input
                value={profile?.description ?? ''}
                onChange={(e) => setProfile((p) => (p ? { ...p, description: e.target.value } : p))}
                placeholder="一句话说明这个项目"
              />
              {agentControls}
              <TeamEditor
                team={profile?.team ?? []}
                onChange={(t) => setProfile((p) => (p ? { ...p, team: t } : p))}
                rootCwd={profile?.rootCwd}
              />
              <GatewayPinField
                value={profile?.gatewayProfile ?? ''}
                onChange={(id) => setProfile((p) => (p ? { ...p, gatewayProfile: id } : p))}
              />
              <div className="settings-actions">
                <button className="primary" onClick={() => void saveProfile()}>
                  保存档案
                </button>
              </div>
            </>
          )}
        </section>

        <section className="settings-card" id="sec-channels">
          <h3>出站通道</h3>
          <p className="settings-hint">
            运行事件（等待审批 / 完成 / 失败）会推送到下面每条已启用的通道。
            原先的「飞书 webhook」配置会在首次读取时自动迁移为一条飞书通道，不会丢。
          </p>
          <ChannelsEditor />
        </section>

        <section className="settings-card" id="sec-roles">
          <h3>全局角色库</h3>
          <p className="settings-hint">
            角色供画布 Agent 节点选择：继承默认 Agent 类型与前置提示。约定文档在上方「项目档案」按项目配置。
          </p>
          <RolesEditor />
        </section>

        <section className="settings-card" id="sec-gateway">
          <h3>模型网关（OmniRoute 等）</h3>
          <p className="settings-hint">
            一站式：填地址+Key → 勾选启用 → 保存并测试。启用后所有 Agent 的模型请求统一走网关
            （claude 未登录也能跑；pi 自动带 --provider openai）。
          </p>
          <GatewayCard />
        </section>

        <section className="settings-card" id="sec-github">
          <h3>GitHub 凭据（供流水线内 gh 命令使用）</h3>
          <p className="settings-hint">
            解决企业托管账号（EMU）无法操作外部仓库的问题：注入 GH_TOKEN 后，Agent 的 gh issue/pr 命令将以此身份执行。
          </p>
          <GithubCredCard />
        </section>

        <section className="settings-card" id="sec-env">
          <h3>环境</h3>
          {env && (
            <p className="settings-hint">
              Herdr：{env.herdrOk ? `已连接 ${env.herdrVersion ?? ''}` : '未连接'} · 已安装 Agent：
              {env.env.agentsInstalled.join('、') || '无'}
            </p>
          )}
          <div className="settings-actions">
            <button onClick={() => void api.health().then(setEnv)}>🔄 重新检测</button>
          </div>
        </section>
      </div>
    </div>
  );
}
