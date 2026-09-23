import { useEffect, useRef, useState } from 'react';
import { api, fetchJson, type Channel, type ChannelType, type NotifyEvent } from '../api.js';
import { useStore } from '../store.js';
import { groupWikiPages, WIKI_GROUP_CAP } from '../wiki-sediment.js';

/** 设置页章节：v10-W 起「项目档案」已迁往「项目」视图，这里只留全局项 */
const SECTIONS: { id: string; label: string; icon: string }[] = [
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
  /** v10-X：GET /user 探到的登录名（探不到时字段缺席） */
  login?: string;
}

/** v10-X 身份行：三种来源都带上 @用户名 */
function credIdentity(g: GithubCredState): string {
  if (g.source === 'none') return '';
  return g.login ? ` · 以 @${g.login} 身份` : ' · 用户名没探到（api.github.com 不可达或 token 缺读权限）';
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
        {g.source === 'stored-pat' && <>来源：本机存储的 PAT · 尾号 {g.tokenTail}{credIdentity(g)}{g.ghLoggedIn ? '；gh 登录态可作兜底' : ''}</>}
        {g.source === 'gh-cli' && <>来源：本机 gh 登录态（现取现用，未写盘）{credIdentity(g)}。动作侧照常可用；想让它也喂给 Agent Pane 里的 gh，可一键导入落盘。</>}
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

/** v10-X wiki 沉淀可见化：状态只读本地缓存（GET /api/wiki/state，零网络）；「拉取远端」显式同步 */
interface WikiStateView {
  repo: string;
  /** v11-C0：缓存克隆所在分支（无缓存时服务端回退 'main'），拼线上链接用 */
  branch: string;
  pageCount: number;
  pages: { file: string; title: string; citedBy: string[] }[];
  /** v11-C3b：该仓沉淀页被 N 个 run 的 wiki 读回真引用过（读时聚合，非写侧字段） */
  citedRunCount: number;
  syncedAt: string;
}

function WikiSedimentCard() {
  const log = useStore((s) => s.log);
  // v11-C5：执行中心发布成功会 bump 这个计数——卡片订阅它即时重拉，不再等手动刷新
  const wikiPublishTick = useStore((s) => s.wikiPublishTick);
  const [st, setSt] = useState<WikiStateView | null>(null);
  const [noRepo, setNoRepo] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const refresh = () =>
    fetchJson<WikiStateView>('GET', '/api/wiki/state')
      .then((d) => {
        setSt(d);
        setNoRepo(false);
      })
      .catch((e: Error) => {
        if (e.message.includes('默认仓库')) setNoRepo(true);
        else log('error', `读取 wiki 沉淀状态失败：${e.message}`);
      });
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wikiPublishTick]);
  const sync = async () => {
    setSyncing(true);
    try {
      const d = await fetchJson<WikiStateView>('POST', '/api/wiki/sync', {});
      setSt(d);
      setNoRepo(false);
      log('info', `wiki 沉淀已同步：${d.pageCount} 页在库`);
    } catch (e) {
      log('error', `wiki 同步失败：${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  };
  if (noRepo) {
    return (
      <p className="settings-hint">
        还没配默认仓库（owner/name）——在上方填好保存后，绿单点赞沉淀的页就会出现在这里。
      </p>
    );
  }
  // v11-C0：落点是主仓默认分支的 llm-wiki/ 目录（Issue #7），不再是 <repo>.wiki
  const treeUrl = st ? `https://github.com/${st.repo}/tree/${st.branch}/llm-wiki` : '';
  // v11-C5：页列表按顶级目录分组；单组不多时全展开，多组时只默认展开首组
  const groups = st ? groupWikiPages(st.pages) : [];
  return (
    <div className="wiki-sediment">
      <div className="wiki-sed-head">
        <b>📚 wiki 沉淀（知识复利）</b>
        {st && (
          <a className="link" href={treeUrl} target="_blank" rel="noreferrer">
            github.com/{st.repo}/tree/{st.branch}/llm-wiki ↗
          </a>
        )}
      </div>
      {!st && <p className="settings-hint">读取中…</p>}
      {st && st.pageCount === 0 && (
        <p className="settings-hint">
          还没有沉淀页：到「执行中心」给一条绿单点赞，即可把结论推到仓库 llm-wiki/ 目录。扩写需求时会自动读本仓沉淀页进上下文。
        </p>
      )}
      {st && st.pageCount > 0 && (
        <>
          <p className="settings-hint">
            {st.pageCount} 页在库
            {st.citedRunCount > 0 && ` · 已被 ${st.citedRunCount} 单读回引用`}
            {st.syncedAt ? ` · 缓存同步于 ${new Date(st.syncedAt).toLocaleString()}` : ' · 本地缓存还没同步过'}
          </p>
          {/* v11-C5：按 file 顶级目录分组（summaries/…、concepts/…，旧扁平页归「其他」垫底），
              每组展示前 5 条；多组时非首组折叠在 <details> 里 */}
          <div className="wiki-page-groups">
            {groups.map((g, i) => (
              <details key={g.dir || '__flat'} className="wiki-page-group" open={i === 0 || groups.length <= 2}>
                <summary>
                  {g.label} · {g.pages.length} 页
                  {/* v11-C3b：组内被引总次数（同一 run 引多页各计——页视角计数） */}
                  {g.pages.reduce((n, p) => n + (p.citedBy?.length ?? 0), 0) > 0 &&
                    ` · 被引 ${g.pages.reduce((n, p) => n + (p.citedBy?.length ?? 0), 0)} 次`}
                </summary>
                <ul className="wiki-page-list">
                  {g.pages.slice(0, WIKI_GROUP_CAP).map((p) => (
                    <li key={p.file}>
                      <a href={`https://github.com/${st.repo}/blob/${st.branch}/llm-wiki/${p.file}`} target="_blank" rel="noreferrer">
                        {p.title}
                      </a>
                      {(p.citedBy?.length ?? 0) > 0 && (
                        <span className="settings-hint" title={`wiki 读回真引用过这页的 run：\n${p.citedBy!.join('\n')}`}>
                          {' '}· 被引 {p.citedBy!.length}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                {g.pages.length > WIKI_GROUP_CAP && (
                  <p className="settings-hint">…本组另有 {g.pages.length - WIKI_GROUP_CAP} 页，见仓库 llm-wiki/{g.dir}/ 目录</p>
                )}
              </details>
            ))}
          </div>
        </>
      )}
      <div className="settings-actions">
        <button className="ghost" disabled={syncing || noRepo} onClick={() => void sync()}>
          {syncing ? '同步中…' : '🔄 从远端拉最新沉淀'}
        </button>
      </div>
    </div>
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
          班底还是空的。到「项目」视图打开档案点「一键装填标准五连」，五个首发 bot（规划/实现/评审/验收/沉淀）就会到位。
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

/** 设置视图：左侧章节导航 + 右侧分区（v10-W：项目档案迁往「项目」视图，这里只剩全局项）。 */
export function SettingsView() {
  const [env, setEnv] = useState<{
    herdrOk: boolean;
    herdrVersion: string | null;
    recommendedAgentKind?: string | null;
    gatewayEnabled?: boolean;
    env: { agentsInstalled: string[] };
  } | null>(null);
  const [active, setActive] = useState(SECTIONS[0]?.id ?? 'channels');
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.health().then(setEnv);
  }, []);

  // 滚动时高亮当前章节
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onScroll = () => {
      let cur = SECTIONS[0]?.id ?? 'channels';
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
            角色供画布 Agent 节点选择：继承默认 Agent 类型与前置提示。约定文档在「项目」视图的档案里按项目配置。
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
          <WikiSedimentCard />
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
