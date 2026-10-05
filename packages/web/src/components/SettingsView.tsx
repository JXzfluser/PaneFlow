import { useEffect, useRef, useState } from 'react';
import { equipSlotLabel, type RoleEquipSlot } from '@paneflow/shared';
import { keepValidSlots, hasEquipRef, removeEquipSlot, splitEquipSlots, toggleEquipRef } from '../equip-slots.js';
import { equipRefOptions, type EquipRefOption, type RegistryEntryView } from '../registry-view.js';
import { api, fetchJson, type Channel, type ChannelType, type NotifyEvent } from '../api.js';
import { useStore } from '../store.js';
import { groupWikiPages, WIKI_GROUP_CAP } from '../wiki-sediment.js';
import { Icon, type IconName } from './Icon.js';
import { PromptModal, type ModalRequest } from './PromptModal.js';
import { removeGatewayProfileRequest, unlinkPatRequest, overwriteIntakeRequest } from '../dialogs.js';

/**
 * 设置页章节分两组（v13 排版分类整顿 → v15-IA 配置枢纽归一）：
 * 「运行底座」= 这机能跑起来吗（环境→模型→凭据→用量，按上手依赖序；能力注册已在「能力」页）；
 * 「班底与复利」= 谁在干活、留下什么（角色→沉淀→外呼）。
 * v10-W 起「项目档案」已迁往「项目」视图，这里只留全局项；
 * v15-IA 注册中心曾并入本页；v18-UI 按设计稿 IA 契约升回一级目的地「能力」
 * （注册=能力登记+配置聚合，是核心模块不是一条设置），本页回归系统级配置。
 */
const SECTION_GROUPS: { label: string; items: { id: string; icon: IconName; label: string }[] }[] = [
  {
    label: '运行底座',
    items: [
      { id: 'env', icon: 'cpu', label: '环境' },
      { id: 'gateway', icon: 'globe', label: '模型网关' },
      { id: 'github', icon: 'code', label: 'GitHub 凭据' },
      { id: 'usage', icon: 'clock', label: '用量' },
    ],
  },
  {
    label: '班底与复利',
    items: [
      { id: 'roles', icon: 'user', label: '角色库' },
      { id: 'wiki', icon: 'book', label: '知识沉淀' },
      { id: 'channels', icon: 'radio', label: '出站通道' },
    ],
  },
];
const SECTIONS = SECTION_GROUPS.flatMap((g) => g.items);

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

  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const r = await api.saveChannels(channels);
      setChannels(r.channels);
      log('info', `已保存 ${r.channels.length} 条通道`);
    } catch (e) {
      log('error', `保存失败：${(e as Error).message}`);
    } finally {
      setSaving(false);
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
                <Icon name="trash" size={13} />
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
                <Icon name="send" size={12} /> {testing === ch.id ? '发送中…' : '测试发送'}
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
        <button className="primary" disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存通道'}
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

/** v18-R4 用量卡：一屏回答「最近烧了多少 token、哪个项目/哪类 agent 烧的、熔断有没有打过」。 */
type UsageReport = Awaited<ReturnType<typeof api.usage>>;

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function UsageCard() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<UsageReport | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    setBusy(true);
    void api
      .usage(days)
      .then((r) => alive && setData(r))
      .catch(() => alive && setData(null))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [days]);
  if (!data) {
    return (
      <div className="settings-actions">
        <span className="settings-hint">{busy ? '用量计算中…' : '用量读数暂不可得（server /api/usage 不可达）'}</span>
      </div>
    );
  }
  const kindName = (k: string) => (k === 'unknown' ? '未落册' : k);
  return (
    <div className="usage-card">
      <div className="usage-window-row">
        {[7, 30, 90].map((d) => (
          <button key={d} className={d === days ? 'on' : ''} disabled={busy} onClick={() => setDays(d)}>
            近 {d} 天
          </button>
        ))}
        <span className="usage-totals">
          <b>{data.totals.runs}</b> 单 · <b>↑{fmtTokens(data.totals.tokensIn)}</b> 入 · <b>↓{fmtTokens(data.totals.tokensOut)}</b> 出
        </span>
      </div>
      <table className="usage-table">
        <thead>
          <tr>
            <th>项目</th>
            <th>单数</th>
            <th>token 入</th>
            <th>token 出</th>
          </tr>
        </thead>
        <tbody>
          {data.bySpace.length === 0 && (
            <tr>
              <td colSpan={4} className="usage-empty">窗口内没有运行记录</td>
            </tr>
          )}
          {data.bySpace.map((s) => (
            <tr key={s.key}>
              <td>{s.key === 'default' ? '默认项目' : s.key}</td>
              <td>{s.runs}</td>
              <td>{fmtTokens(s.tokensIn)}</td>
              <td>{fmtTokens(s.tokensOut)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.byKind.length > 0 && (
        <div className="usage-kinds">
          {data.byKind.map((k) => (
            <span className="usage-kind-chip" key={k.key} title={`${k.runs} 单 · ↑${k.tokensIn} ↓${k.tokensOut}`}>
              {kindName(k.key)} × {k.runs}
            </span>
          ))}
        </div>
      )}
      <p className="settings-hint">
        预算熔断（PF_RUN_MAX_TOKENS）：{data.budget.envMaxTokens === null ? '未设（关闭）' : `run 级上限 ${fmtTokens(data.budget.envMaxTokens)}`}
        {data.budget.tripRuns > 0 ? ` · 窗口内触发过 ${data.budget.tripRuns} 次` : ' · 窗口内未触发'}
      </p>
    </div>
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
        还没配默认仓库（owner/name）——在上方「GitHub 凭据」一节填好保存后，绿单点赞沉淀的页就会出现在这里。
      </p>
    );
  }
  // v11-C0：落点是主仓默认分支的 llm-wiki/ 目录（Issue #7），不再是 <repo>.wiki
  const treeUrl = st ? `https://github.com/${st.repo}/tree/${st.branch}/llm-wiki` : '';
  // v11-C5：页列表按顶级目录分组；单组不多时全展开，多组时只默认展开首组
  const groups = st ? groupWikiPages(st.pages) : [];
  return (
    <div className="wiki-sediment">
      {st && (
        <a className="link wiki-sed-repo" href={treeUrl} target="_blank" rel="noreferrer">
          <code>github.com/{st.repo}/tree/{st.branch}/llm-wiki</code>
          <Icon name="external" size={11} />
        </a>
      )}
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
          <Icon name="refresh" size={12} /> {syncing ? '同步中…' : '从远端拉最新沉淀'}
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



interface Role {
  id: string;
  name: string;
  agentKind?: string;
  prePrompt?: string;
  env?: Record<string, string>;
  /**
   * v13-W1 岗位装备·技能槽（引用项目 skills 登记清单；键缺省=未配槽，吃项目全量）。
   * v14-A5-5b 起同一格还能写 `{kind,id}` 注册表定点引用（`RoleEquipSlot`＝两写法并存）：
   * 勾选面两列上下排（前列产裸路径、后列产引用，角色卡只有 ~260px 宽，塞不进左右两栏），
   * 两列各说各的尺，不互相翻译。
   */
  skills?: RoleEquipSlot[];
  /** v13-W1 岗位装备·岗位文档槽（评审清单类家规，与项目规则按路径去重）；两写法同上 */
  rules?: RoleEquipSlot[];
  /** v13-W3 授权声明三面（声明非强制：只入 prompt + 收口对账，拦不了真动作） */
  declares?: Record<string, boolean>;
}

/** v13-W3 授权面：与 shared 的 DECLARE_FACES 同集，界面上只这三格 */
const DECLARE_FACES: { key: string; label: string; hint: string }[] = [
  { key: 'gitPush', label: 'git push', hint: '向远程仓库推提交' },
  { key: 'prOpen', label: '开 PR', hint: '在远端创建 Pull Request' },
  { key: 'issueWrite', label: '写 Issue', hint: '建单或回写 Issue 正文' },
];

/**
 * v13-W1 岗位装备·可选项：从各项目的登记清单汇出来（技能=profile.skills，
 * 岗位文档=profile.rules[].file），界面上只让人**勾选**、不让人打字编路径。
 * 角色是全局库、项目是多个，故一条路径带「哪些项目登记了它」——
 * 没登记的那个项目注入时会跳过不注（落 equip.unknownSkills 只披露），界面把这话明说。
 */
interface EquipOption {
  path: string;
  spaces: string[];
  note?: string;
}

interface SpaceEquipSource {
  id: string;
  name: string;
  skills?: string[];
  rules?: ({ file?: string; note?: string } | string)[];
}

function buildEquipCatalog(spaces: SpaceEquipSource[]): { skills: EquipOption[]; docs: EquipOption[] } {
  const skillMap = new Map<string, EquipOption>();
  const docMap = new Map<string, EquipOption>();
  for (const sp of spaces) {
    for (const p of sp.skills ?? []) {
      if (typeof p !== 'string' || !p) continue;
      const cur = skillMap.get(p) ?? { path: p, spaces: [] };
      cur.spaces.push(sp.name);
      skillMap.set(p, cur);
    }
    for (const item of sp.rules ?? []) {
      const rule = typeof item === 'string' ? { file: item } : item;
      const p = typeof rule.file === 'string' ? rule.file : '';
      if (!p) continue;
      const cur = docMap.get(p) ?? { path: p, spaces: [] };
      cur.spaces.push(sp.name);
      if (rule.note && !cur.note) cur.note = rule.note;
      docMap.set(p, cur);
    }
  }
  const sort = (a: EquipOption, b: EquipOption) => a.path.localeCompare(b.path);
  return {
    skills: [...skillMap.values()].sort(sort),
    docs: [...docMap.values()].sort(sort),
  };
}

/**
 * 装备槽勾选器：两写法两列上下排——前列是**本项目的登记清单**（勾它产裸相对路径），
 * 后列是**注册中心的条目**（勾它产 `{kind,id}`）。两列不是同一篇文档的两个画法：
 * 裸串走池子尺（换个项目还能指到同名那篇），定点引用认那一枚条目自己（条目改了它跟着改、
 * 被引用还受注册表的删除闸护着），所以这里两列都留着，谁也不替谁。
 * 清单外的裸串另列一行如实标出；已写进去的引用同样列出来、能摘掉。
 */
function EquipPicker(props: {
  label: string;
  hint: string;
  options: EquipOption[];
  selected: RoleEquipSlot[];
  onChange: (next: RoleEquipSlot[]) => void;
  /** 定点引用那一面的可选项（注册中心的 `skill`/`rule` 条目；空数组＝表里这类还没有条目） */
  refOptions: EquipRefOption[];
  /** 注册中心那一刀读没读到：读不到时明说「没读到」，不拿空列表冒充「没有条目」 */
  refsRead: boolean;
}) {
  const { label, hint, options, selected, onChange, refOptions, refsRead } = props;
  const { bare, refs, unknown } = splitEquipSlots(selected, options.map((o) => o.path));
  const toggle = (path: string, on: boolean) =>
    onChange(on ? [...selected, path] : removeEquipSlot(selected, path));
  return (
    <div className="equip-slot">
      <label>{label}</label>
      <div className="settings-listbox">
        {options.map((o) => (
          <label key={o.path} className="settings-check" title={o.note ?? o.path}>
            <input
              type="checkbox"
              checked={bare.includes(o.path)}
              onChange={(e) => toggle(o.path, e.target.checked)}
            />
            <code>{o.path}</code>
            <span className="equip-src">{o.spaces.join('、')}</span>
          </label>
        ))}
        {options.length === 0 && <span className="settings-hint">各项目还没登记可选文档</span>}
      </div>
      <div className="equip-refpick">
        <label>定点引用（注册中心条目：认那一枚自己登记的文档，不吃本项目的清单）</label>
        <div className="settings-listbox">
          {refOptions.map((o) => (
            <label key={o.id} className="settings-check" title={`${o.space} · ${o.file}`}>
              <input
                type="checkbox"
                checked={hasEquipRef(selected, o)}
                onChange={() => onChange(toggleEquipRef(selected, { kind: o.kind, id: o.id }))}
              />
              <code>{o.file}</code>
              <span className="equip-src">{o.space}</span>
            </label>
          ))}
          {!refsRead && <span className="settings-hint">注册中心那一刀没读到（上面的勾选不受影响）</span>}
          {refsRead && refOptions.length === 0 && (
            <span className="settings-hint">注册中心里还没有这一类条目（先去登记一枚，才能定点引用）</span>
          )}
        </div>
      </div>
      {refs.length > 0 && (
        <p className="equip-refs">
          <Icon name="target" size={12} /> 定点引用（照注册中心条目解析，注入死活看那一面的探针）：
          {refs.map((ref) => (
            <span key={`${ref.kind}:${ref.id}`} className="equip-ref">
              <code>{equipSlotLabel(ref)}</code>
              <button className="ghost tiny" onClick={() => onChange(removeEquipSlot(selected, ref))}>
                摘掉
              </button>
            </span>
          ))}
        </p>
      )}
      {unknown.length > 0 && (
        <p className="equip-unknown">
          <Icon name="alert" size={12} /> 清单外（该项目注入时跳过不注）：
          {unknown.map((p) => ` ${p}`).join('；')}
          <button
            className="ghost tiny"
            onClick={() => onChange(keepValidSlots(selected, options.map((o) => o.path)))}
          >
            清掉
          </button>
        </p>
      )}
      <div className="equip-manual open">
        <button
          className="ghost tiny"
          onClick={() => useStore.getState().setView('caps')}
        >
          登记清单里没有？去「能力」页新增
        </button>
      </div>
      <p className="settings-hint">{hint}</p>
    </div>
  );
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
  /** v9-B1 标准五连的固定 id（自愈修复按钮的适用判据；角色定义正身在 server 的 roles.ts） */
  const STD_TEAM_ROLE_IDS = new Set(['std-planner', 'std-implementer', 'std-reviewer', 'std-verifier', 'std-curator']);
  const [repairing, setRepairing] = useState(false);
  /** 草稿：卡背上正在编辑的样子 */
  const [roles, setRoles] = useState<Role[]>([]);
  /** 在册：最后一次 PUT /api/roles 成功后服务端认下的样子——两者不等即「未保存」 */
  const [committed, setCommitted] = useState<Role[]>([]);
  const [catalog, setCatalog] = useState<{ skills: EquipOption[]; docs: EquipOption[] }>({ skills: [], docs: [] });
  /** v14-A5-5b-2 定点引用那一列的取材：`null`=那一刀还没读到（与「表里没这类条目」分家） */
  const [registryEntries, setRegistryEntries] = useState<RegistryEntryView[] | null>(null);
  const [spaceNames, setSpaceNames] = useState<{ id: string; name: string }[]>([]);
  const [usage, setUsage] = useState<Record<string, RoleUsage>>({});
  const [agentKinds, setAgentKinds] = useState<string[]>([]);
  useEffect(() => {
    void fetchJson<{ roles?: Role[] }>('GET', '/api/roles')
      .then((d) => {
        const rs = d.roles ?? [];
        setRoles(rs);
        setCommitted(rs);
      })
      .catch((e: Error) => log('error', `读取角色库失败：${e.message}`));
    // 部署数只是角标信息：拉不到不报错，阵容照画
    void fetchJson<{ usage?: Record<string, RoleUsage> }>('GET', '/api/roles/usage')
      .then((d) => setUsage(d.usage ?? {}))
      .catch(() => undefined);
    // 装备勾选清单=各项目登记清单的并集（数据面走 GET /api/spaces，界面上不新造判据）
    void fetchJson<{ spaces?: SpaceEquipSource[] }>('GET', '/api/spaces')
      .then((d) => {
        const sp = d.spaces ?? [];
        setCatalog(buildEquipCatalog(sp));
        setSpaceNames(sp.map((s) => ({ id: s.id, name: s.name })));
      })
      .catch(() => undefined); // 拉不到清单=裸路径那一列空着，只剩注册中心那一列可勾
    // 定点引用那一列吃注册中心的条目表（R3 只读视图，与「注册中心」页同一份读数）；拉不到留 null，
    // 界面明说「那一刀没读到」——拿空列表冒充「没有可引用的条目」会把人的判断带走
    void api
      .registryList()
      .then((d) => setRegistryEntries(d.entries))
      .catch(() => undefined);
    void api.health().then((h) => setAgentKinds(h.agentKinds));
  }, []);
  /** 整库 PUT（/api/roles 是全量替换语义）；成功才把草稿升格为在册，失败留在未保存态 */
  const save = (next: Role[], note: string) => {
    setRoles(next);
    void fetchJson<unknown>('PUT', '/api/roles', { roles: next })
      .then(() => {
        setCommitted(next);
        log('info', note);
      })
      .catch((e: Error) => log('error', `保存失败，改动还在草稿里：${e.message}`));
  };
  const saveCard = (role: Role) =>
    save(roles, `角色「${role.name}」已保存（装备槽改了要重跑单才生效——roleSha 在注入现场取值）`);
  const discardCard = (id: string) =>
    setRoles((rs) => rs.map((r) => (r.id === id ? (committed.find((c) => c.id === id) ?? r) : r)));
  const patch = (id: string, part: Partial<Role>) =>
    setRoles((rs) => rs.map((r) => (r.id === id ? { ...r, ...part } : r)));
  const isDirty = (role: Role) =>
    JSON.stringify(committed.find((c) => c.id === role.id) ?? null) !== JSON.stringify(role);
  // 稳定排序：标准五连按链序打头，其余按入库顺序
  const sorted = [...roles].sort((a, b) => {
    const ia = BOT_ORDER.indexOf(a.id);
    const ib = BOT_ORDER.indexOf(b.id);
    return (ia < 0 ? 100 : ia) - (ib < 0 ? 100 : ib);
  });
  const ghosts = Object.entries(usage).filter(([id]) => !roles.some((r) => r.id === id));
  // 定点引用那一列的取材：条目表整份拿回来再按轴分（server 的 R3 视图不替角色页筛，筛在这儿做，
  // 判据只有「这一枚是不是这一类、还在不在册」两问，不重算 id、不判跨项目能不能注）
  const refsRead = registryEntries !== null;
  const readEntries = registryEntries ?? [];
  const skillRefOptions = equipRefOptions(readEntries, 'skill', spaceNames);
  const docRefOptions = equipRefOptions(readEntries, 'rule', spaceNames);
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
          const dirty = isDirty(r);
          const equipped = r.skills !== undefined || r.rules !== undefined;
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
                  <span className="bot-meta">{r.agentKind ? <code>{r.agentKind}</code> : '默认 Agent'}</span>
                  {/* v13-W1 三轴划界的可见面：没配装备槽的岗其实在吃项目全量，这事实摊开在卡面上 */}
                  <span className="bot-meta">
                    {r.skills === undefined && r.rules === undefined
                      ? '未配装备 · 吃项目全量'
                      : `装备 · 技能 ${r.skills?.length ?? 0} · 岗位文档 ${r.rules?.length ?? 0}`}
                  </span>
                  {/* 改了没落盘必须看得见：以前卡背编辑只改本地状态，刷新即蒸发（无人发现的静默丢改动） */}
                  {r.declares !== undefined && (
                    <span className="bot-meta" title="授权声明只入指令与收口对账，不拦真动作">
                      授权 · 已勾 {Object.values(r.declares).filter(Boolean).length}/{DECLARE_FACES.length} 面
                    </span>
                  )}
                  {dirty && (
                    <span className="bot-meta dirty" title="还没保存到服务端">
                      ● 未保存
                    </span>
                  )}
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
                {/* v13-W1 岗位装备槽的三态：没配（吃项目全量）/ 配了吃勾选 / 配了且清空（一口都不吃）。
                    旧界面把「模式」藏进「两个文本框空不空」，于是永远解释不清 [] 与未配的差别——
                    现在模式是一等控件，勾选清单来自各项目登记（不再要求手打路径）。 */}
                <label>岗位装备</label>
                <select
                  value={equipped ? 'own' : 'space'}
                  onChange={(e) =>
                    patch(
                      r.id,
                      e.target.value === 'own'
                        ? { skills: r.skills ?? [], rules: r.rules ?? [] }
                        : { skills: undefined, rules: undefined },
                    )
                  }
                  title="没配装备的岗吃该项目登记的全部文档；配了槽就只吃选中的这几篇（裸路径或注册中心条目）"
                >
                  <option value="space">吃项目全量（默认，不配槽）</option>
                  <option value="own">自带装备（勾项目登记清单 / 注册中心条目）</option>
                </select>
                {equipped && (
                  <>
                    <EquipPicker
                      label="技能（来自各项目的 skills 登记）"
                      hint="显式清空=这个岗一口技能文档都不吃（与「吃项目全量」是两回事）"
                      options={catalog.skills}
                      selected={r.skills ?? []}
                      onChange={(next) => patch(r.id, { skills: next })}
                      refOptions={skillRefOptions}
                      refsRead={refsRead}
                    />
                    <EquipPicker
                      label="岗位文档（来自各项目的规则登记）"
                      hint="与项目规则同路径只注一份；评审清单类家规挂这里"
                      options={catalog.docs}
                      selected={r.rules ?? []}
                      onChange={(next) => patch(r.id, { rules: next })}
                      refOptions={docRefOptions}
                      refsRead={refsRead}
                    />
                  </>
                )}
                {/* v13-W3 授权声明：PaneFlow 不造沙箱，声明只入 prompt + 收口对账（落差只照不拦）。
                    三态同装备槽：不声明=今日静默；声明即逐面给布尔（false 才有对账资格）。 */}
                <label>岗位授权声明（非强制：只写进指令与收口对账，拦不了真动作）</label>
                <select
                  value={r.declares === undefined ? 'off' : 'on'}
                  onChange={(e) =>
                    patch(
                      r.id,
                      e.target.value === 'on'
                        ? { declares: r.declares ?? { gitPush: false, prOpen: false, issueWrite: false } }
                        : { declares: undefined },
                    )
                  }
                  title="真正的能力锁配在你自己的 agent CLI 侧；这里声明的是「本岗该不该干这三件事」，落差会进账"
                >
                  <option value="off">不声明（默认，与今天一致）</option>
                  <option value="on">声明本岗授权面</option>
                </select>
                {r.declares !== undefined && (
                  <div className="settings-listbox declares">
                    {DECLARE_FACES.map((f) => (
                      <label key={f.key} className="settings-check" title={f.hint}>
                        <input
                          type="checkbox"
                          checked={r.declares?.[f.key] === true}
                          onChange={(e) =>
                            patch(r.id, { declares: { ...(r.declares ?? {}), [f.key]: e.target.checked } })
                          }
                        />
                        {f.label}
                        <span className="equip-src">{f.hint}</span>
                      </label>
                    ))}
                  </div>
                )}
                <div className="bot-card-foot">
                  <button className="primary" disabled={!dirty} onClick={() => saveCard(r)}>
                    <Icon name="save" size={12} /> 保存这张卡
                  </button>
                  <button className="ghost" disabled={!dirty} onClick={() => discardCard(r.id)}>
                    放弃修改
                  </button>
                  <button
                    className="ghost"
                    onClick={() => save(roles.filter((x) => x.id !== r.id), `角色「${r.name}」已删除`)}
                    title="从角色库删除（各项目班底里的引用会悬空，界面会标出）"
                  >
                    <Icon name="trash" size={12} /> 删除角色
                  </button>
                </div>
              </details>
            </div>
          );
        })}
      </div>
      {ghosts.length > 0 && (
        <div className="bot-ghosts">
          <p>
            <Icon name="alert" size={12} /> 班底里还引用着已不在库的角色：
            {ghosts.map(([id, ps]) => ` ${id}（${ps.map((p) => p.name).join('、')}）`).join('；')}
          </p>
          {/* v18 自愈口：悬空的全是标准五连（v9-B1 固定 id）→ 角色库补缺即复位，班底一个字节不动
              （seedOnly=1 明确不覆写班底——那里可能有用户自定义成员）。非标准角色悬空不亮此钮，
              得人去建同名角色——界面上不假装能自动修。 */}
          {ghosts.every(([id]) => STD_TEAM_ROLE_IDS.has(id)) && (
            <button
              className="ghost"
              disabled={repairing}
              onClick={() => {
                const spaceId = ghosts.find(([, ps]) => ps.length > 0)?.[1][0]?.spaceId;
                if (!spaceId) return;
                setRepairing(true);
                void fetchJson<unknown>('POST', `/api/spaces/${encodeURIComponent(spaceId)}/team/standard?seedOnly=1`)
                  .then(() => fetchJson<{ roles?: Role[] }>('GET', '/api/roles'))
                  .then((d) => {
                    const rs = d.roles ?? [];
                    setRoles(rs);
                    setCommitted(rs);
                    return fetchJson<{ usage?: Record<string, RoleUsage> }>('GET', '/api/roles/usage');
                  })
                  .then((d) => {
                    setUsage(d.usage ?? {});
                    log('info', '标准五连已补回角色库——班底悬空引用复位（班底档案未被改动）');
                  })
                  .catch((e: Error) => log('error', `补回失败：${e.message}`))
                  .finally(() => setRepairing(false));
              }}
            >
              {repairing ? '补回中…' : '⚡ 一键补回标准五连（修复悬空引用）'}
            </button>
          )}
        </div>
      )}
      <button
        className="ghost"
        onClick={() => {
          const next = [...roles, { id: `role-${Date.now().toString(36)}`, name: `角色 ${roles.length + 1}` }];
          save(next, '已新增角色（名字与人设在卡背上补，补完记得「保存这张卡」）');
        }}
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
  // 这一枚探测要现起子进程问本机装了哪些 agent（herdr 也在里面），不是瞬时——点了没说「在探」就会被再按一次
  const [envBusy, setEnvBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const probeEnv = () => {
    setEnvBusy(true);
    return api
      .health()
      .then(setEnv)
      .finally(() => setEnvBusy(false));
  };

  useEffect(() => {
    void probeEnv();
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
        {SECTION_GROUPS.map((g) => (
          <div className="settings-nav-group" key={g.label}>
            <span className="settings-nav-grouplabel">{g.label}</span>
            {g.items.map((s) => (
              <button
                key={s.id}
                className={`settings-nav-item${active === s.id ? ' on' : ''}`}
                onClick={() => jump(s.id)}
              >
                <span className="settings-nav-icon">
                  <Icon name={s.icon} size={13} />
                </span>
                {s.label}
              </button>
            ))}
          </div>
        ))}
      </nav>

      <div className="settings-body" ref={bodyRef}>
        <section className="settings-card" id="sec-env">
          <h3>环境</h3>
          {env && (
            <p className="settings-hint">
              Herdr：{env === null ? '检测中…' : env.herdrOk ? `已连接 ${env.herdrVersion ?? ''}` : '未连接'} · 已安装 Agent：
              {env.env.agentsInstalled.join('、') || '无'}
            </p>
          )}
          <div className="settings-actions">
            <button disabled={envBusy} onClick={() => void probeEnv()}>
              <Icon name="refresh" size={12} /> {envBusy ? '检测中…' : '重新检测'}
            </button>
          </div>
        </section>

        <section className="settings-card" id="sec-gateway">
          <h3>模型网关（OmniRoute 等）</h3>
          <GatewayCard />
        </section>

        <section className="settings-card" id="sec-github">
          <h3>GitHub 凭据</h3>
          <GithubCredCard />
        </section>

        <section className="settings-card" id="sec-usage">
          <h3>用量</h3>
          <p className="settings-hint">token 只认引擎收口落册的成本账（agent 自报累计，绝不估算）；归档单也计入。</p>
          <UsageCard />
        </section>

        <section className="settings-card" id="sec-wiki">
          <h3>知识沉淀（wiki 复利）</h3>
          <WikiSedimentCard />
        </section>

        <section className="settings-card" id="sec-roles">
          <h3>全局角色库</h3>
          <p className="settings-hint">
            角色供画布 Agent 节点选择：继承默认 Agent 类型与前置提示。约定文档在「项目」视图的档案里按项目配置。
          </p>
          <RolesEditor />
        </section>

        <section className="settings-card" id="sec-channels">
          <h3>出站通道</h3>
          <ChannelsEditor />
        </section>

      </div>
    </div>
  );
}

function GatewayCard() {
  const log = useStore((s) => s.log);
  const [g, setG] = useState({ baseUrl: '', freeModel: '', enabled: false, keyConfigured: false });
  const [profiles, setProfiles] = useState<GatewayProfileView[]>([]);
  const [apiKey, setApiKey] = useState('');
  type GatewayTestResult = { ok: boolean; models?: number; error?: string; chatOk?: boolean; chatError?: string };
  const [testing, setTesting] = useState<{ note: string; cls: string } | null>(null);
  const [newName, setNewName] = useState('');
  const [swPath, setSwPath] = useState('');
  const [swCandidates, setSwCandidates] = useState<SwitchCandidate[] | null>(null);
  const [swPicked, setSwPicked] = useState<string[]>([]);
  const [modal, setModal] = useState<ModalRequest | null>(null);
  const runTest = async (): Promise<void> => {
    setTesting({ note: '探测中…', cls: 'settings-action-note' });
    const r = await fetchJson<GatewayTestResult>('POST', '/api/gateway/test').catch(
      (e: Error): GatewayTestResult => ({ ok: false, error: e.message }),
    );
    // 列模型 ≠ 能对话：只有真实 chat completion 通过才算「可用」
    setTesting(
      !r.ok
        ? { note: r.error ?? '连接失败', cls: 'settings-fail' }
        : r.chatOk
          ? { note: `已连通 · ${r.models} 个模型 · 对话验证通过`, cls: 'inline-ok' }
          : { note: `能列模型但对话失败：${r.chatError ?? '原因未知'}（展开「免费档模型」换个 id）`, cls: 'settings-warn' },
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
  const [saving, setSaving] = useState<'' | 'save' | 'asNew'>('');
  const save = async () => {
    setSaving('save');
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
    } finally {
      setSaving('');
    }
  };
  /** D2：把上方表单当前内容另存为一档新网关（不动生效档） */
  const saveAsNew = async () => {
    setSaving('asNew');
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
    } finally {
      setSaving('');
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
  // v14-A5-5a：这枚删除面自此问引用账——被项目钉着的档 400 点名出处。
  // 那句拒答从前只弹一条会自己消失的 toast，现在显示在确认框内部且不关窗，人来得及读完「先改哪几处」。
  const removeProfile = (p: GatewayProfileView) =>
    setModal(
      removeGatewayProfileRequest(p.name, async () => {
        await fetchJson<{ ok: boolean }>('DELETE', `/api/gateway/profile/${encodeURIComponent(p.id)}`);
        await refresh();
        log('info', `已删除档「${p.name}」`);
      }),
    );
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
        {testing && <span className={testing.cls}>{testing.note}</span>}
        <button className="primary" disabled={saving !== ''} onClick={() => void save()}>
          <Icon name="save" size={12} /> {saving === 'save' ? '保存中…' : '保存并测试'}
        </button>
      </div>
      {/* v9-D2 多网关档：上面表单编辑的是生效档；并存其他网关在下方列表里切/删 */}
      <div className="gw-profiles">
        <h4>网关档位</h4>
        <p className="settings-hint">
          共 {profiles.length} 档 · 上方表单保存 = 改生效档「{profiles.find((p) => p.isCurrent)?.name ?? '—'}」
        </p>
        {profiles.map((p) => (
          <div className="gw-profile" key={p.id}>
            <b className={p.isCurrent ? 'gw-cur' : ''}>{p.isCurrent ? '● ' : '○ '}{p.name}</b>
            <span className="settings-hint">
              <code>{p.baseUrl || '（无地址）'}</code> · {p.keyConfigured ? 'key ✓' : '无 key'}
              {p.freeModel ? ` · ${p.freeModel}` : ''}
              {p.enabled === false ? ' · 已停用' : ''}
            </span>
            {!p.isCurrent && (
              <button className="sm" onClick={() => void switchTo(p)}>设为生效</button>
            )}
            {profiles.length > 1 && (
              <button className="sm ghost" title="删除此档" onClick={() => removeProfile(p)}>
                <Icon name="x" size={11} />
              </button>
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
            disabled={!newName.trim() || saving !== ''}
            title="把上方表单里的地址/Key/模型另存为一档新网关（需要填 Key）"
            onClick={() => void saveAsNew()}
          >
            {saving === 'asNew' ? '存档中…' : '＋ 另存为新档'}
          </button>
        </div>
      </div>
      <details className="settings-more">
        <summary>从外部配置导入网关（cc Switch / 同类 switcher 的 JSON）</summary>
        <div className="settings-row">
          <input
            value={swPath}
            onChange={(e) => setSwPath(e.target.value)}
            placeholder="配置文件绝对路径，如 /Users/you/.cc-switch/config.json"
            aria-label="外部配置文件路径"
          />
          <button disabled={!swPath.trim()} onClick={() => void probeImport()}>
            <Icon name="search" size={12} /> 识别
          </button>
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
                {c.name} · <code>{c.baseUrl}</code> · key…<code>{c.keyTail}</code>{c.freeModel ? ` · ${c.freeModel}` : ''}
              </label>
            ))}
            <div className="settings-actions">
              <button className="primary" disabled={!swPicked.length} onClick={() => void applyImport()}>
                <Icon name="download" size={12} /> 导入勾选（{swPicked.length}）
              </button>
            </div>
          </>
        )}
      </details>
      {modal && <PromptModal req={modal} onClose={() => setModal(null)} />}
    </>
  );
}

function GithubCredCard() {
  const log = useStore((s) => s.log);
  const [g, setG] = useState<GithubCredState>({ tokenConfigured: false, defaultRepo: '' });
  const [token, setToken] = useState('');
  const [modal, setModal] = useState<ModalRequest | null>(null);
  const refresh = () =>
    fetchJson<GithubCredState>('GET', '/api/github/cred')
      .then(setG)
      .catch((e: Error) => log('error', `读取 GitHub 凭据状态失败：${e.message}`));
  useEffect(() => {
    void refresh();
  }, []);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
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
    } finally {
      setSaving(false);
    }
  };
  const [writing, setWriting] = useState(false);
  const [importing, setImporting] = useState(false);
  /** U2：解绑=只清本机存的 PAT，gh 登录态兜底还在（确认走 D3 模态，报错显示在框内） */
  const unlink = () =>
    setModal(
      unlinkPatRequest(async () => {
        await fetchJson<{ unlinked: boolean }>('POST', '/api/github/cred/unlink');
        log('info', '已解绑本机存储的 PAT');
        void refresh();
      }),
    );
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
      // 409「已存在，要覆盖得显式 overwrite」：原生的二次确认换成 D3 模态，server 那句原文直接当说明
      if (msg.includes('overwrite')) setModal(overwriteIntakeRequest(msg, () => writeIntake(true)));
      else log('error', `接单模板回写失败：${msg}`);
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
        {g.source === 'stored-pat' && <>来源：本机存储的 PAT · 尾号 <code>{g.tokenTail}</code>{credIdentity(g)}{g.ghLoggedIn ? '；gh 登录态可作兜底' : ''}</>}
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
        <button className="primary" disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存凭据'}
        </button>
        <button title="读取本机 `gh auth token` 的登录态并存入（gh 未登录会给出两条备选路）" aria-label="读取本机 `gh auth token` 的登录态并存入（gh 未登录会给出两条备选路）" disabled={importing} onClick={() => void importGh()}>
          <Icon name="key" size={12} /> {importing ? '导入中…' : '从 gh CLI 一键导入'}
        </button>
        {g.source === 'stored-pat' && (
          <button className="ghost" title="只清本机存的 PAT（默认仓库保留；gh 登录态兜底不受影响）" onClick={() => unlink()}>
            解绑本机存储
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
          {writing ? '回写中…' : (
            <>
              <Icon name="doc" size={12} /> 回写接单模板 → 默认仓库
            </>
          )}
        </button>
      </div>
      {modal && <PromptModal req={modal} onClose={() => setModal(null)} />}
    </>
  );
}
