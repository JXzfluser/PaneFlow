import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { api, fetchJson, getSpace, type EnvProbeItem } from '../api.js';
import { useStore } from '../store.js';
import type { AppView } from '../store.js';
import { Icon } from './Icon.js';
import {
  buildRegistryPayload,
  deriveNameFromValue,
  formFieldsFor,
  formatWhen,
  groupEntriesByKind,
  healthDot,
  healthIndex,
  healthTitle,
  isViewEntry,
  kindGroupLabel,
  mergeCandidates,
  missingRequiredFields,
  probeFileCandidates,
  probeNote,
  probeOriginCandidates,
  refCountOf,
  refNote,
  refRows,
  rejectedSummary,
  registrableKinds,
  spaceDocCandidates,
  spaceRepoCandidates,
  REGISTRY_NAME_FIELD,
  sourceLabel,
  specRows,
  viewEnabledCell,
  whenLabels,
  type RegistryEntryView,
  type RegistryFormField,
  type RegistryFormValues,
  type RegistryHealthReadout,
  type RegistryListResponse,
  type RegistryProbeResponse,
  type SpaceDocCandidateSource,
} from '../registry-view.js';

/** 行上四类写动作：在飞读数按这一枚点名（同一条目的四发不能共用一句话） */
type RowOp = 'toggle' | 'delete' | 'probe' | 'probe-refresh';

/**
 * v17-F2：每类能力登记后的三步填法——说人话、给全例子。表单不再只靠字段 hint 让人猜：
 * 「技能到底是个什么文件、MCP 命令怎么写、登记完去哪生效」这三个问题在这里答掉。
 */
const FORM_GUIDE: Record<string, string[]> = {
  model: [
    '① 配了网关就点「刷新型号清单」从探得的清单里选；没配网关直接填型号名也可以',
    '② 起个显示名（留空会自动取型号名）',
    '③ 登记后：画布 Agent 节点的「模型」一格就能选到它',
  ],
  skill: [
    '① 选所属项目——文档路径相对这个项目的根，换项目=换文件',
    '② 填文档路径：如 skills/review.md 或 skills/review/SKILL.md（选完项目会自动扫出盘上候选，点牌即可填）',
    '③ 登记后：该项目跑任务时这篇文档自动注入给 Agent（当它的作业手册）',
  ],
  rule: [
    '① 选所属项目 + 填文档路径（如 docs/conventions.md）',
    '② 可限定只在某仓库/某目录生效；两格都留空 = 整个项目都守这条',
    '③ 登记后：命中范围的节点注入上下文时都会带上它',
  ],
  repo: [
    '① 选所属项目 + 填本地目录名（相对项目根，如 ChuanCloud-catalog）',
    '② 有远端就填 owner/repo（派活时 --repo 认的也是这一串）',
    '③ 登记后：交付家规按它拉分支、建 PR；「仓库」下拉也用它',
  ],
  mcp: [
    '① 填启动命令：本机可执行文件（绝对路径或 PATH 上的名字），如 npx 或 uvx',
    '② 参数原样存一行不拆词，如：-y @modelcontextprotocol/server-filesystem /path/to/dir',
    '③ 登记后：模板可声明「这单需要这台 server」；工具桥接还没上，这一版先做声明账',
  ],
};

/**
 * v14 X1 注册中心（M0 可感面）：一张表 + 一组动词，登记走表单、**永远不写 JSON**。
 * 家规：判定全在 server——label / rejected.why / 400 error 都是 server 给的一句人话，原样转述；
 * 这里不重算 id、不校 spec 形状（必填齐没齐是 UI 礼节不是校验）、不把「缺读数」画成 0。
 * v15-IA：整体并入「设置 → 能力注册」（配置枢纽归一），`embedded` 收起页头大标题。
 */
/** v17-F3：常用 MCP server 预设（对标 Cursor/Claude Desktop 的"从清单选，而不是默写命令"）。
 *  命令与参数照官方 README 常见写法；落册前仍走 server 的形状校验。路径/token 是本机事，点了再改。 */
const MCP_PRESETS: { label: string; command: string; args: string; note: string }[] = [
  { label: '📂 本地文件', command: 'npx', args: '-y @modelcontextprotocol/server-filesystem /path/to/dir', note: '让 Agent 读写指定目录下的文件' },
  { label: '🌐 网页抓取', command: 'uvx', args: 'mcp-server-fetch', note: '抓取网页转 Markdown 给 Agent' },
  { label: '🧠 长期记忆', command: 'npx', args: '-y @modelcontextprotocol/server-memory', note: '知识图谱式持久记忆' },
  { label: '🐙 GitHub', command: 'npx', args: '-y @modelcontextprotocol/server-github', note: '仓库/Issue/PR 操作（需配 GITHUB_TOKEN 环境）' },
];

/** v18 全卡片化：每类能力卡的图标与一句话说明（11 类全覆盖，未知类回落 🧩）。 */
const KIND_ICON: Record<string, string> = {
  model: '🧠',
  skill: '📚',
  rule: '📏',
  repo: '📦',
  mcp: '🔌',
  'agent-kind': '⚙️',
  'node-type': '⬡',
  'check-type': '✅',
  role: '👤',
  template: '▦',
  'gateway-profile': '🌐',
};
const KIND_DESC: Record<string, string> = {
  model: '登记 claude/gpt 等型号，Agent 节点才能选到它',
  skill: '一篇 Markdown 作业手册，运行时自动注入给 Agent',
  rule: '团队硬约束（分支命名、提交规范），按项目/仓库生效',
  repo: '告诉 Agent 去哪个代码仓干活，交付家规按它拉分支',
  mcp: '本机 MCP server 的启动命令（声明账，供模板声明依赖）',
  'agent-kind': '本机可驱动的编码 Agent 引擎（探活=装没装）',
  'node-type': '编排图可用的节点种类（代码现算）',
  'check-type': '引擎实跑得了的机检类型（代码现算）',
  role: '班底岗位——条目是镜子，正身在角色库',
  template: '画布图即模板——条目是镜子，正身在编排页',
  'gateway-profile': '模型网关档位——正身在设置·网关',
};

/** v18 打磨：视图类能力的管理面直链——条目是镜子，正身在别处，详情里把路指过去。
 *  check-type/node-type/agent-kind 由代码现算、没有独立管理面，不给跳（不画死链）。 */
const VIEW_HOME_JUMPS: Record<string, { label: string; go: (setView: (v: AppView) => void) => void }> = {
  role: {
    label: '去设置 · 角色库',
    go: (setView) => {
      setView('settings');
      requestAnimationFrame(() => document.getElementById('sec-roles')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    },
  },
  template: { label: '去编排页（模板即画布图）', go: (setView) => setView('orchestrate') },
  'gateway-profile': {
    label: '去设置 · 模型网关',
    go: (setView) => {
      setView('settings');
      requestAnimationFrame(() => document.getElementById('sec-gateway')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    },
  },
};

export function RegistryView({ embedded = false }: { embedded?: boolean }) {
  const [activeKind, setActiveKind] = useState<string | null>(null); // null = 全部
  const [kindTab, setKindTab] = useState<string | null>(null); // Tab 页签选中的类别（null=第一个）
  const [scanPromptOpen, setScanPromptOpen] = useState(false);
  const [scanPath, setScanPath] = useState('');
  const [scanRegisterBusy, setScanRegisterBusy] = useState(false);
  const [scanPreview, setScanPreview] = useState<{ items: { kind: string; name: string; detail: string }[]; selected: Set<number> } | null>(null);
  const log = useStore((s) => s.log);
  const setView = useStore((s) => s.setView);
  const [data, setData] = useState<RegistryListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 登记那一发：表单唯一一次「填完再点」的写
  const [formBusy, setFormBusy] = useState(false);
  /**
   * 行上那一发点的是哪个动词：启停／探一次／现探／删除共用同一枚条目 id，只带 id 的话
   * 「停用中…」和「删除中…」会一起亮、两枚探针按钮同时改口——在飞读数要点名到那一发，不能让人猜。
   */
  const [writeOp, setWriteOp] = useState<{ id: string; op: RowOp } | null>(null);
  const rowBusy = (id: string) => writeOp?.id === id;
  const opBusy = (id: string, op: RowOp) => writeOp?.id === id && writeOp.op === op;
  const [detailId, setDetailId] = useState<string | null>(null);
  // 对某条目最近一次写失败的服务端原文（进详情抽屉披露，不 toast 完就蒸发）
  const [writeErrors, setWriteErrors] = useState<Record<string, string>>({});
  /**
   * R4 健康点：**独立一刀、后于表到达**（`/api/registry` 保持纯读盘）。
   * `null` 且无错＝还在探（那一格什么都不画，不画灰点冒充「不健康」）；读不出只说健康点这一刀，表照常。
   */
  const [health, setHealth] = useState<Map<string, RegistryHealthReadout> | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  // 整表那一刀在飞：按钮没这份读数就只是「点了一下没反应」——网关挂住时是几秒的静默动作
  const [healthBusy, setHealthBusy] = useState(false);
  /**
   * X1 单枚探针（`registry probe` 的 UI 落点）：id → 刚做过的那一次回执或失败原话。
   * 与批量那一刀分家存放——批量是「整表扫一遍」，单枚是「我就问这一条」，混进同一张 map
   * 就分不清哪个读数是刚现探的。
   */
  const [probed, setProbed] = useState<Record<string, { res?: RegistryProbeResponse; err?: string }>>({});

  const [formOpen, setFormOpen] = useState(false);
  const [formKind, setFormKind] = useState('model');
  const [formName, setFormName] = useState('');
  const [formValues, setFormValues] = useState<RegistryFormValues>({});
  const [formError, setFormError] = useState<string | null>(null);
  // 表单选项源：网关档下拉 + 型号候选（探得清单，不是自由发挥的白名单——仍可直接填）
  const [gwProfiles, setGwProfiles] = useState<{ id: string; name: string }[]>([]);
  const [modelCandidates, setModelCandidates] = useState<string[]>([]);
  const [catalogNote, setCatalogNote] = useState<string | null>(null);
  /**
   * `skill`/`rule` 表单的候选（v14 A5-1/A5-2）：项目下拉读 `/api/spaces`，文档路径与仓库目录名读
   * **所选项目档案里已有的值**（`GET /api/spaces/:id`）。前端不拼路径、不猜目录：候选读不出来时，
   * 直填那一格照旧可走——候选是省手的，不是白名单。
   * 档案里没登记过路径时另有一把尺：拿这个项目的 `rootCwd` 走一次**只读**环境探测
   * （`/api/env/probe`，v14-E1），把盘上真有的那几篇端成点一下就能填的牌——登记面的手打字数
   * 不该由「档案里恰好记没记过」决定。判据仍在 server（这里只照抄它给的相对路径），网页不 stat 任何东西。
   */
  const [spaces, setSpaces] = useState<{ id: string; name: string; rootCwd?: string }[]>([]);
  const [spacesNote, setSpacesNote] = useState<string | null>(null);
  const [docCandidates, setDocCandidates] = useState<string[]>([]);
  const [repoCandidates, setRepoCandidates] = useState<string[]>([]);
  const [candidatesNote, setCandidatesNote] = useState<string | null>(null);
  /** 表单的三个候选源共用这一份读数：它们同一次一起读、一起失败，各挂一个转圈就是三处说谎的机会 */
  const [optionsBusy, setOptionsBusy] = useState(false);
  const selectedSpace = typeof formValues.space === 'string' ? formValues.space : '';
  /** 所选项目的根（本机探测的唯一基准；档案里没填就是 undefined——那一轮扫描干脆不开口） */
  const selectedSpaceRoot = spaces.find((s) => s.id === selectedSpace)?.rootCwd;

  /**
   * 本机只读探测的候选（盘上真有的那几篇）：与档案候选**分开存**，因为两枚出处说的是两件事——
   * 「档案里登记过」与「这个根下有这篇」。混成一池就再没人看得出某条候选其实只来自其中一处。
   * 按 space 缓一份：换项目才重扫，同一次开表单里来回切 kind 不再重复走盘。
   */
  const [scan, setScan] = useState<{ space: string; items: EnvProbeItem[]; note: string | null } | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const scanned = scan?.space === selectedSpace ? scan : null;
  const docChoices = useMemo(
    () => mergeCandidates(docCandidates, probeFileCandidates(scanned?.items ?? [])),
    [docCandidates, scanned],
  );
  const originChoices = useMemo(() => probeOriginCandidates(scanned?.items ?? []), [scanned]);

  /** 扫一次这个项目的根（只读：server 侧 stat/readdir + 三条只读 git 命令，绝不写盘） */
  const scanSpaceRoot = useCallback(
    (id: string, root: string, force = false) => {
      if (!id || !root) return;
      if (!force && scan?.space === id) return;
      let dead = false;
      setScanBusy(true);
      api
        .envProbe(root)
        .then((r) => {
          if (dead) return;
          setScan({ space: id, items: r.items ?? [], note: r.error ?? null });
        })
        .catch((e: Error) => {
          if (dead) return;
          setScan({ space: id, items: [], note: `本机探测没回话：${e.message}` });
        })
        .finally(() => {
          if (!dead) setScanBusy(false);
        });
      return () => {
        dead = true;
      };
    },
    [scan?.space],
  );

  // 选了项目就顺手扫一次根：登记面该问的是「这台机器上有什么」，不是「档案里恰好记过什么」
  useEffect(() => {
    if (!formOpen || !selectedSpace) return;
    const root = spaces.find((s) => s.id === selectedSpace)?.rootCwd;
    if (!root) return;
    return scanSpaceRoot(selectedSpace, root) as (() => void) | undefined;
  }, [formOpen, selectedSpace, spaces, scanSpaceRoot]);

  const closeForm = () => {
    setFormOpen(false);
    setFormError(null);
  };

  // 表单是就地展开的长块：Esc 收它，与向导／弹窗同一把手势。登记在飞时不挂这个键——
  // 那一发还没落账，此刻收掉界面等于让人以为「取消了」而条目其实已经写进表里
  useEffect(() => {
    if (!formOpen || formBusy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeForm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [formOpen, formBusy]);

  const loadHealth = useCallback((refresh: boolean) => {
    setHealthBusy(true);
    return api
      .registryHealth(refresh)
      .then((r) => {
        setHealth(healthIndex(r));
        setHealthError(null);
      })
      .catch((e: Error) => setHealthError(e.message))
      .finally(() => setHealthBusy(false));
  }, []);

  const load = useCallback(() =>
    api
      .registryList()
      .then((r) => {
        setData(r);
        setLoadError(null);
      })
      .catch((e: Error) => setLoadError(e.message))
      // 表先到、点后到：健康那一刀不 await——网关挂掉时表照样读得出，只有点缺着（R4 分刀的理由）
      .finally(() => void loadHealth(false)),
  [loadHealth]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * v17-F3「别让人抄清单」（对标 Dify/Cursor 的做法——供应商接上，型号自动全进来）：
   * 网关探得的型号支持**批量一键导入**，登记模型不再一格一格手填。挂载时就探一次
   * （catalog 有 5min 缓存，与设置页网关卡同源同缓存），导入动作仍逐条走 /api/registry，
   * 判重与形状校验全在 server——重复那几条吃 400 计数跳过就好，前端不自造判据（R4）。
   */
  const [gwCatalog, setGwCatalog] = useState<{ id: string; models: string[]; freeModel?: string }[] | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  useEffect(() => {
    void api
      .gatewayCatalog()
      .then((r) =>
        setGwCatalog(
          r.profiles
            .filter((p) => !p.error && Array.isArray(p.models))
            .map((p) => ({ id: p.id, models: p.models, freeModel: p.freeModel })),
        ),
      )
      .catch(() => setGwCatalog(null));
  }, []);

  const ensureFormOptions = useCallback(() => {
    setOptionsBusy(true);
    void Promise.allSettled([
      api
        .gatewayProfiles()
        .then((r) => setGwProfiles(r.profiles.map((p) => ({ id: p.id, name: p.name }))))
        .catch((e: Error) => setCatalogNote(`网关档清单读不出：${e.message}`)),
      api
        .listSpaces()
        .then((r) => {
          setSpaces(r.spaces.map((s) => ({ id: s.id, name: s.name, rootCwd: s.rootCwd })));
          setSpacesNote(null);
        })
        .catch((e: Error) => setSpacesNote(`项目清单读不出：${e.message}`)),
      api
        .gatewayCatalog()
        .then((r) => {
          setModelCandidates([...new Set(r.profiles.flatMap((p) => p.models))]);
          const errs = r.profiles.filter((p) => p.error).map((p) => `${p.name}：${p.error}`);
          setCatalogNote(errs.length ? `型号探得不全：${errs.join('；')}` : null);
        })
        .catch((e: Error) => setCatalogNote(`型号清单探读失败：${e.message}`)),
    ]).then(() => setOptionsBusy(false));
  }, []);

  /** 选了项目才去读那一枚档案拿路径候选（不选就不请求；读不出只说候选这一格，直填那条路不受影响） */
  useEffect(() => {
    const wantsCandidates = formKind === 'skill' || formKind === 'rule' || formKind === 'repo';
    if (!formOpen || !wantsCandidates || !selectedSpace) {
      setDocCandidates([]);
      setRepoCandidates([]);
      return;
    }
    let dead = false;
    fetchJson<SpaceDocCandidateSource>('GET', `/api/spaces/${encodeURIComponent(selectedSpace)}`)
      .then((p) => {
        if (dead) return;
        const id = p?.id || selectedSpace;
        setDocCandidates(spaceDocCandidates([p], id));
        setRepoCandidates(spaceRepoCandidates([p], id));
        setCandidatesNote(null);
      })
      .catch((e: Error) => {
        if (dead) return;
        setDocCandidates([]);
        setRepoCandidates([]);
        setCandidatesNote(`这个项目的文档与仓库清单读不出：${e.message}（路径仍可直填）`);
      });
    return () => {
      dead = true;
    };
  }, [formOpen, formKind, selectedSpace]);

  const refreshCatalog = () => {
    // 不洗 catalogNote：刷新在飞时上一次的失败原文仍是「最后一次读数」，把它换成转圈就是抹掉证据
    setOptionsBusy(true);
    api
      .gatewayCatalog(true)
      .then((r) => {
        setModelCandidates([...new Set(r.profiles.flatMap((p) => p.models))]);
        const errs = r.profiles.filter((p) => p.error).map((p) => `${p.name}：${p.error}`);
        setCatalogNote(errs.length ? `型号探得不全：${errs.join('；')}` : null);
      })
      .catch((e: Error) => setCatalogNote(`型号清单刷新失败：${e.message}`))
      .finally(() => setOptionsBusy(false));
  };

  /**
   * 任何入口开表单都走这一枚（v17-F1）：此前引导卡直接 `setFormOpen(true)` 绕过了候选读取，
   * 「明明有项目、下拉里却没有」就是这么来的——现在 kind 设定与候选兜底收在同一个门口，
   * 上次没读全或读挂了（note 挂着原话）也再探一次，网关修好后重开表单能自愈。
   */
  const openFormWithKind = (kind?: string) => {
    if (kind) {
      setFormKind(kind);
      setFormValues({});
      setFormError(null);
    }
    setFormOpen(true);
    if (optionsBusy) return;
    if (
      gwProfiles.length === 0 ||
      modelCandidates.length === 0 ||
      spaces.length === 0 ||
      catalogNote !== null ||
      spacesNote !== null
    )
      ensureFormOptions();
  };

  const openForm = () => {
    if (formOpen) {
      setFormOpen(false);
      return;
    }
    openFormWithKind();
  };

  const switchKind = (kind: string) => {
    setFormKind(kind);
    setFormValues({});
    setFormError(null);
  };

  /** 每类表单的「正身格」（字段自己声明 `primary`，不拿「第一个必填」猜——头一格常是所属项目，那是作用域不是名字） */
  const primaryFieldOf = (kind: string): string | undefined => formFieldsFor(kind)?.find((f) => f.primary)?.key;

  const setValue = (key: string, v: string | boolean) => {
    setFormValues((vs) => ({ ...vs, [key]: v }));
  };

  /**
   * 名字空着才从「正身格」派生（人填过的一个字都不动）：路径填完还要再打一遍名字，是这一页最没道理的一格。
   * 只在**离开那一格**和**点候选牌**时代填，不在每次按键时代填——边打字边写名字会把「docs/bot-s…」的前缀
   * 钉进名字里（第一个字符一落定就再也不覆盖了）。
   */
  const fillNameFromPrimary = () => {
    const pk = primaryFieldOf(formKind);
    if (!pk || formName.trim()) return;
    const v = formValues[pk];
    if (typeof v === 'string' && v.trim()) setFormName(deriveNameFromValue(v));
  };

  /** 点候选牌：填进那一格，并顺手把名字带上（候选是完整值，不存在「取到半个前缀」那件事） */
  const pickCandidate = (f: RegistryFormField, value: string) => {
    setValue(f.key, value);
    if (!formName.trim()) setFormName(deriveNameFromValue(value));
  };

  const submit = async () => {
    const missing = missingRequiredFields(formKind, formName, formValues);
    if (missing.length) {
      setFormError(`请先填写：${missing.join('、')}`);
      return;
    }
    const payload = buildRegistryPayload(formKind, formName, formValues);
    if (!payload) {
      setFormError('这一类还没长表单字段，界面不登记不认识的形状');
      return;
    }
    setFormBusy(true);
    try {
      await api.registryAdd(payload);
      setFormOpen(false);
      setFormName('');
      setFormValues({});
      setFormError(null);
      await load();
      log('info', `注册中心：已登记「${payload.name}」`);
    } catch (e) {
      // 服务端的 400 一句人话原样inline挂出；已经填的内容一个字不清
      setFormError((e as Error).message);
    } finally {
      setFormBusy(false);
    }
  };

  const recordWriteError = (id: string, msg: string) =>
    setWriteErrors((m) => ({ ...m, [id]: msg }));

  const toggleEnabled = async (entry: RegistryEntryView) => {
    setWriteOp({ id: entry.id, op: 'toggle' });
    try {
      const r = await api.registryPatch(entry.id, { enabled: !entry.enabled });
      setData((d) => (d ? { ...d, entries: d.entries.map((e) => (e.id === r.entry.id ? r.entry : e)) } : d));
    } catch (e) {
      recordWriteError(entry.id, (e as Error).message);
      void load(); // 以服务端实态为准回滚本地显示
    } finally {
      setWriteOp(null);
    }
  };

  /**
   * 探一次（只问这一条，吃 server 那份 5min 实探缓存；`refresh=true` 才绕开）。
   * 读数回来了顺手喂给表上那颗点——同一份判据、同一个字段，只是这一枚更新，
   * 于是「我刚探的这条」和「整表上次扫的」不会画成两样。
   */
  const probeOnce = async (entry: RegistryEntryView, refresh = false) => {
    setWriteOp({ id: entry.id, op: refresh ? 'probe-refresh' : 'probe' });
    try {
      const res = await api.registryProbe(entry.id, refresh);
      setProbed((m) => ({ ...m, [entry.id]: { res } }));
      if (res.health) {
        const readout = res.health;
        setHealth((m) => {
          const next = new Map(m ?? []);
          next.set(entry.id, readout);
          return next;
        });
      }
    } catch (e) {
      setProbed((m) => ({ ...m, [entry.id]: { err: (e as Error).message } }));
    } finally {
      setWriteOp(null);
    }
  };

  const remove = async (entry: RegistryEntryView) => {
    setWriteOp({ id: entry.id, op: 'delete' });
    try {
      await api.registryDelete(entry.id);
      setDetailId((d) => (d === entry.id ? null : d));
      await load();
      log('info', `注册中心：已删除「${entry.name}」`);
    } catch (e) {
      recordWriteError(entry.id, (e as Error).message);
      log('error', `注册中心：删除「${entry.name}」失败：${(e as Error).message}`);
    } finally {
      setWriteOp(null);
    }
  };

  /**
   * 字段的候选集，按字段自己声明的源取（`options`=下拉、`list`=datalist）。
   * 渲染侧不再写死 `key === 'gatewayProfile'` / `key === 'model'`——那种字符串比对加一类字段就得改一处画法。
   * 返回统一 {id,name}：id 是提交值，name 是显示值（型号与路径两样都是自身）。
   */
  const fieldChoices = (f: RegistryFormField): { id: string; name: string }[] => {
    if (f.options === 'spaces') return spaces;
    if (f.options === 'gateway-profiles') return gwProfiles;
    if (f.list === 'models') return modelCandidates.map((m) => ({ id: m, name: m }));
    if (f.list === 'space-docs') return docChoices.map((p) => ({ id: p, name: p }));
    if (f.list === 'space-repos') return repoCandidates.map((r) => ({ id: r, name: r }));
    if (f.list === 'repo-origins') return originChoices.map((o) => ({ id: o, name: o }));
    return [];
  };

  const listIdFor = (list: NonNullable<RegistryFormField['list']>): string =>
    list === 'models'
      ? 'pf-registry-model-candidates'
      : list === 'space-docs'
        ? 'pf-registry-space-docs'
        : list === 'repo-origins'
          ? 'pf-registry-repo-origins'
          : 'pf-registry-space-repos';

  const groups = data
    ? groupEntriesByKind(data.entries, data.knownKinds, data.viewKinds ?? [], data.kindLabels, data.viewHomes)
    : [];
  const rejectedText = data ? rejectedSummary(data.rejected) : null;
  // 表单只问能登记的那几类：视图 kind（出厂清单与角色库那几类）没有表单形状，选它必被 server 拒，不在这里挂出来
  const kinds = registrableKinds(data?.knownKinds ?? [], data?.viewKinds ?? []);

  const registeredModelIds = useMemo(
    () => new Set(groups.find((g) => g.kind === 'model')?.entries.map((e) => e.id) ?? []),
    [groups],
  );
  // v18 全卡片化：每类一张能力卡的账面——图标/条数/探活（绿=探通、红=探明不在；无通道不装读数）、
  // 条目速览前 3 个名字。点击聚焦该类；胶囊跳转栏与条目表格一并退役。
  const regSet = new Set(kinds);
  const kindCards = groups.map((g) => {
    let live = 0;
    let missing = 0;
    for (const e of g.entries) {
      const d = healthDot(health?.get(e.id));
      if (d === 'ok') live += 1;
      else if (d === 'bad') missing += 1;
    }
    const preview = g.entries.slice(0, 3).map((e) => e.name);
    return {
      kind: g.kind,
      label: kindGroupLabel(g.kind, data?.kindLabels),
      total: g.entries.length,
      live,
      missing,
      icon: KIND_ICON[g.kind] ?? '🧩',
      desc: KIND_DESC[g.kind] ?? (g.home ? `条目由${g.home}现算` : '登记类能力'),
      view: Boolean(g.view),
      registrable: regSet.has(g.kind),
      preview,
      more: Math.max(0, g.entries.length - preview.length),
    };
  });
  const gatewayModelTotal = gwCatalog?.reduce((n, p) => n + p.models.length, 0) ?? 0;

  const importGatewayModels = () => {
    setImportBusy(true);
    let ok = 0;
    let dup = 0;
    const jobs: Promise<unknown>[] = [];
    for (const p of gwCatalog ?? []) {
      for (const m of p.models) {
        const spec: Record<string, string | boolean> = { model: m };
        if (p.freeModel === m) spec.freeModel = true;
        jobs.push(
          api
            .registryAdd({ kind: 'model', name: m, spec })
            .then(() => void ok++)
            .catch(() => void dup++),
        );
      }
    }
    void Promise.allSettled(jobs).then(() => {
      setImportBusy(false);
      log('info', `网关型号导入完成：新增 ${ok} 枚${dup ? `，已在册/跳过 ${dup} 枚` : ''}${ok + dup > 0 ? '。点「模型」胶囊查看' : ''}`);
      void load();
    });
  };

  // 点跳转栏滚到那一组。CSS 里的 prefers-reduced-motion 全局关停管不到 JS 行为，这里自己问一次
  const jumpToGroup = (kind: string) => {
    const el = document.getElementById(`registry-g-${kind}`);
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  };

  return (
    <div className="registry-view">
        {!embedded && (
          <>
            <h2>注册中心</h2>
            <p className="settings-hint">
              能力清单的一张表：登记、启停、删除都走这里的表单，不用写 JSON。判定全在服务端，本页只渲染它给的话。
            </p>
          </>
        )}

        {/* R-newbie → v17-F2：五张能力卡即登记入口——每张说清「登记了有什么用」，点了就开表单。
            MCP 此前没有入口（只能靠胶囊 Tab 里那枚 0 项的格子找到），补上。 */}
        <div className="reg-guide">
          <div className="reg-guide-title">登记一项能力（都不用写 JSON）</div>
          {/* v17-F3 主路径优先：能自动进来的绝不手填——网关型号批量导入 / 项目目录扫描 */}
          {gatewayModelTotal > 0 && (
            <div className="reg-import">
              <span>
                ⚡ 网关已探得 <b>{gatewayModelTotal}</b> 个型号
                {registeredModelIds.size > 0 ? `（已在册 ${registeredModelIds.size} 个）` : '，一枚都还没登记'}
                ——不用手填，一键全进来：
              </span>
              <button className="primary" disabled={importBusy} onClick={importGatewayModels}>
                {importBusy ? '导入中…' : `一键导入${registeredModelIds.size < gatewayModelTotal ? `（${gatewayModelTotal - registeredModelIds.size} 枚待入）` : '（查漏补缺）'}`}
              </button>
            </div>
          )}
          <div className="reg-guide-scan">
            <span style={{ color: 'var(--text-dim)', fontSize: 11.5 }}>
              <b>一键接入整个项目：</b>给一个本地目录，自动发现里面的仓库/约定/技能/规则，勾选后批量登记（不用抄路径）。
            </span>
            <button style={{ marginLeft: 'auto' }} onClick={() => { setScanPromptOpen(true); setScanPreview(null); }}>
              🔍 扫描项目目录
            </button>
            {scanPromptOpen && (
              <div className="reg-scan-prompt">
                <label>要扫描的目录（绝对路径）</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={scanPath}
                    onChange={(e) => { setScanPath(e.target.value); setScanPreview(null); }}
                    placeholder="/Users/you/work/my-project"
                    style={{ flex: 1, background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px', font: 'inherit' }}
                  />
                  <button disabled={!scanPath.trim()} onClick={() => {
                    api.envProbe(scanPath.trim())
                      .then((r) => {
                        const items = r.items ?? [];
                        setScanPreview({ items, selected: new Set(items.map((_, i) => i)) });
                      })
                      .catch((e: Error) => log('error', `扫描失败：${e.message}`));
                  }}>
                    🔍 扫描
                  </button>
                </div>
                {scanPreview && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ color: 'var(--text-dim)', fontSize: 11.5, marginBottom: 4 }}>
                      发现 {scanPreview.items.length} 项，勾选要登记的：
                    </div>
                    <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 6 }}>
                      {scanPreview.items.map((it, i) => (
                        <label key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 11.5, padding: '2px 4px' }}>
                          <input
                            type="checkbox"
                            checked={scanPreview.selected.has(i)}
                            onChange={(e) =>
                              setScanPreview((p) => {
                                if (!p) return p;
                                const next = new Set(p.selected);
                                if (e.target.checked) next.add(i);
                                else next.delete(i);
                                return { ...p, selected: next };
                              })
                            }
                          />
                          <span style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)', fontSize: 10.5 }}>{it.kind}</span>
                          <span>{it.name}</span>
                          <span style={{ color: 'var(--text-dim)', fontSize: 10.5, marginLeft: 'auto' }}>{it.detail}</span>
                        </label>
                      ))}
                      {scanPreview.items.length === 0 && <span style={{ color: 'var(--text-dim)' }}>没发现可登记的项</span>}
                    </div>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button
                    className="primary"
                    disabled={scanRegisterBusy || !scanPreview}
                    onClick={() => {
                      const sp = getSpace();
                      setScanRegisterBusy(true);
                      api.envRegister(scanPath.trim(), sp, Array.from(scanPreview!.selected))
                        .then((r) => {
                          log('info', `一键登记完成：${r.registered} 项已入 ${sp} 空间档案`);
                          void load();
                          setScanPreview(null);
                          setScanPromptOpen(false);
                        })
                        .catch((e: Error) => log('error', `登记失败：${e.message}`))
                        .finally(() => setScanRegisterBusy(false));
                    }}
                  >
                    {scanRegisterBusy ? '登记中…' : `✓ 登记 ${scanPreview?.selected.size ?? 0} 项`}
                  </button>
                  <button onClick={() => setScanPromptOpen(false)}>取消</button>
                </div>
              </div>
            )}
          </div>
          {/* 单项登记卡：自动路径覆盖不到的，按类点卡开表单（表单里有三步引导与示例） */}
          <div className="reg-guide-grid">
            <button className="reg-guide-item" onClick={() => openFormWithKind('model')}>
              <span className="reg-guide-icon">🧠</span>
              <span><b>模型</b><small>登记 claude/gpt 等型号，Agent 节点才能选到它</small></span>
            </button>
            <button className="reg-guide-item" onClick={() => openFormWithKind('skill')}>
              <span className="reg-guide-icon">📚</span>
              <span><b>技能</b><small>一篇 Markdown 作业手册（如 skills/review.md），运行时自动注入给 Agent</small></span>
            </button>
            <button className="reg-guide-item" onClick={() => openFormWithKind('rule')}>
              <span className="reg-guide-icon">📏</span>
              <span><b>规则</b><small>团队硬约束（分支命名、提交规范），按项目/仓库生效</small></span>
            </button>
            <button className="reg-guide-item" onClick={() => openFormWithKind('repo')}>
              <span className="reg-guide-icon">📦</span>
              <span><b>仓库</b><small>告诉 Agent 去哪个代码仓干活，交付家规按它拉分支</small></span>
            </button>
            <button className="reg-guide-item" onClick={() => openFormWithKind('mcp')}>
              <span className="reg-guide-icon">🔌</span>
              <span><b>MCP 服务</b><small>登记本机 MCP server 的启动命令（内置常用模板，点选即填）</small></span>
            </button>
            <button className="reg-guide-item" onClick={() => { setKindTab(null); setActiveKind(null); }}>
              <span className="reg-guide-icon">🔍</span>
              <span><b>全部能力</b><small>下方胶囊按类查看，含引擎/角色/模板等系统能力</small></span>
            </button>
          </div>
        </div>
        {formOpen && (
        <>
        <div className="registry-form-backdrop" onClick={closeForm} />
        <div className="registry-form" role="dialog" aria-modal="true" aria-label="登记能力">
          <div className="registry-form-headrow">
            <h3 className="registry-form-title">登记{kindGroupLabel(formKind, data?.kindLabels)}</h3>
            <button className="registry-form-close" aria-label="关闭登记表单" onClick={closeForm}>✕</button>
          </div>
          <p className="registry-form-sub">带 * 的必填项填完即可登记，其余字段可稍后在条目上补充。</p>
          {FORM_GUIDE[formKind] && (
            <ol className="registry-form-guide">
              {FORM_GUIDE[formKind].map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          )}
          <div className="registry-form-field">
            <label htmlFor="reg-kind">能力类型</label>
            <select
              id="reg-kind"
              value={formKind}
              autoFocus
              onChange={(ev) => switchKind(ev.target.value)}
            >
              {(kinds.length ? kinds : [formKind]).map((k) => (
                <option key={k} value={k}>
                  {kindGroupLabel(k, data?.kindLabels)}
                </option>
              ))}
            </select>
          </div>

          {formFieldsFor(formKind) ? (
            <>
              {/* v17-F3：MCP 不用默写命令——四枚常用模板点一下填好，改路径/贴 token 即可 */}
              {formKind === 'mcp' && (
                <div className="registry-form-field">
                  <label>常用模板（点一下自动填，再改成本机路径）</label>
                  <div className="registry-picks">
                    {MCP_PRESETS.map((p) => (
                      <button
                        key={p.label}
                        type="button"
                        className="registry-pick"
                        title={`${p.command} ${p.args}`}
                        onClick={() => {
                          setFormName(p.label.replace(/^\S+\s/, ''));
                          setValue('command', p.command);
                          setValue('args', p.args);
                          setValue('note', p.note);
                        }}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="registry-form-field">
                <label htmlFor="reg-name">{REGISTRY_NAME_FIELD.label} *</label>
                <input
                  id="reg-name"
                  value={formName}
                  placeholder={REGISTRY_NAME_FIELD.hint}
                  onChange={(ev) => setFormName(ev.target.value)}
                />
              </div>
              {formFieldsFor(formKind)!.map((f) => {
                if (f.type === 'checkbox') {
                  return (
                    <label className="registry-form-check" key={f.key}>
                      <input
                        type="checkbox"
                        checked={formValues[f.key] === true}
                        onChange={(ev) => setValue(f.key, ev.target.checked)}
                      />
                      {f.label}
                      {f.hint && <span className="settings-hint">（{f.hint}）</span>}
                    </label>
                  );
                }
                const lid = f.list ? listIdFor(f.list) : undefined;
                return (
                  <div className="registry-form-field" key={f.key}>
                    <label htmlFor={`reg-${f.key}`}>
                      {f.label}
                      {f.required ? ' *' : ''}
                    </label>
                    {f.type === 'select' ? (
                      <>
                        <select
                          id={`reg-${f.key}`}
                          value={typeof formValues[f.key] === 'string' ? (formValues[f.key] as string) : ''}
                          onChange={(ev) => setValue(f.key, ev.target.value)}
                        >
                          <option value="">{f.options === 'spaces' ? '选一个项目' : '不指定'}</option>
                          {fieldChoices(f).map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                        {/* 空下拉有两种读法（清单没读到 / 这个项目下真一个候选都没有），分开说，别拿「不指定」糊过去 */}
                        {f.options === 'spaces' && !spaces.length && (
                          <p className="settings-hint">{spacesNote ?? '还没有项目档案可列（先去「项目」里建一个，或直接提交）。'}</p>
                        )}
                      </>
                    ) : (
                      <>
                        <input
                          id={`reg-${f.key}`}
                          list={lid}
                          value={typeof formValues[f.key] === 'string' ? (formValues[f.key] as string) : ''}
                          placeholder={f.hint}
                          onChange={(ev) => setValue(f.key, ev.target.value)}
                          onBlur={f.primary ? fillNameFromPrimary : undefined}
                        />
                        {lid && (
                          <>
                            <datalist id={lid}>
                              {fieldChoices(f).map((c) => (
                                <option key={c.id} value={c.id} />
                              ))}
                            </datalist>
                            {f.list === 'models' && (
                              <button
                                className="link"
                                type="button"
                                disabled={optionsBusy}
                                onClick={refreshCatalog}
                              >
                                {optionsBusy ? '刷新中…' : '刷新型号清单'}
                              </button>
                            )}
                            {/* 候选牌：路径这一格「看得见才点得动」——datalist 要人先敲一下输入框
                                才知道底下挂了什么，而本机扫出来的那几篇本来就该摆在眼前 */}
                            {/* 候选牌：这一格挂了什么要「看得见才点得动」——datalist 要人先敲一下输入框
                                才知道底下有什么，而网关探出的型号、本机扫出的路径/远端仓本来就该摆在眼前。
                                每一格有候选就摆牌（四类候选源同一画法），没候选只说这一轮没探到——候选是省手的，
                                不是白名单：牌子永远不拦直填（server 才是判形状的那一处） */}
                            {(fieldChoices(f).length > 0 || f.list === 'space-docs' || f.list === 'repo-origins') && (
                            <div className="registry-picks">
                              {fieldChoices(f)
                                .slice(0, 8)
                                .map((c) => (
                                  <button
                                    key={c.id}
                                    type="button"
                                    className="registry-pick"
                                    onClick={() => pickCandidate(f, c.id)}
                                    title={`${c.id} → 填进「${f.label}」这一格`}
                                  >
                                    {c.id}
                                  </button>
                                ))}
                              {fieldChoices(f).length > 8 && (
                                <span className="registry-picks-note">
                                  另有 {fieldChoices(f).length - 8} 条：在这一格打头几个字就能筛
                                </span>
                              )}
                              {(f.list === 'space-docs' || f.list === 'repo-origins') && (
                                <button
                                  className="link"
                                  type="button"
                                  disabled={scanBusy || !selectedSpaceRoot}
                                  onClick={() => selectedSpaceRoot && scanSpaceRoot(selectedSpace, selectedSpaceRoot, true)}
                                  title="只读扫一遍这个项目的根（stat/readdir + 三条只读 git 命令），不写盘"
                                >
                                  {scanBusy ? '扫描中…' : '重扫本机'}
                                </button>
                              )}
                            </div>
                            )}
                            {f.list === 'space-docs' && (
                              <p className="settings-hint">
                                {scanBusy
                                  ? '正在扫这个项目的根…（只读，探的是盘上真有什么，不动任何文件）'
                                  : !selectedSpace
                                    ? '先选项目：选好就把那个项目的根扫一遍，盘上的文档直接摆成牌子。'
                                    : !selectedSpaceRoot
                                      ? '这个项目没配主仓根目录，本机扫不了（相对路径仍可直填，或去「项目」里补根目录）。'
                                      : scanned?.note
                                        ? scanned.note
                                        : candidatesNote ??
                                          `已扫 ${selectedSpaceRoot}：候选＝档案里登记过的 ∪ 盘上探到的，直填也照旧可走。`}
                              </p>
                            )}
                            {f.list === 'models' && !modelCandidates.length && (
                              <p className="settings-hint">
                                {catalogNote ?? '网关还没探出型号清单（没配网关档，或探的过程失败了）——型号这一格直接填也照旧可走。'}
                              </p>
                            )}
                            {f.list === 'space-repos' && !repoCandidates.length && (
                              <p className="settings-hint">
                                {selectedSpace
                                  ? candidatesNote ?? '这个项目还没登记过仓库目录——直接填目录名即可（留空=全空间都守这条）。'
                                  : '先选项目，这里会列出它档案里已登记的仓库目录。'}
                              </p>
                            )}
                          </>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
              {optionsBusy && (
                <p className="settings-hint">候选读取中…（网关档／型号／项目清单一起探，读不出来那一格也能直接填）</p>
              )}
              {catalogNote && <p className="settings-hint">{catalogNote}</p>}
            </>
          ) : (
            <p className="settings-hint">这一类还没长表单字段，界面不登记不认识的形状。</p>
          )}

          {formError && <p className="registry-form-error">{formError}</p>}
          <div className="registry-form-ops">
            <button className="ghost" onClick={closeForm}>
              取消
            </button>
            <button className="primary" disabled={formBusy} onClick={() => void submit()}>
              {formBusy ? '登记中…' : '登记'}
            </button>
          </div>
        </div>
        </>
      )}

      <>

      {loadError && (
        <p className="registry-load-fail">注册表读不出：{loadError}</p>
      )}

      {/* 重探在飞时不说上一轮的失败原话：那一行与「重探中」同时挂出来是两句互相打架的话 */}
      {healthError && !healthBusy && (
        <p className="registry-load-fail">
          健康点读不出：{healthError}（表不受影响：那一格没点＝不知道，不是「不健康」）
        </p>
      )}

      {healthBusy && (
        <p className="settings-hint">
          {health
            ? '正在重探健康点…（下面这些点还是上一次读数）'
            : '健康点探测中…（与型号清单同一份实探缓存，不拖读表）'}
        </p>
      )}

      {rejectedText && data && (
        <div className="registry-rejected">
          <p>{rejectedText}</p>
          <ul>
            {data.rejected.map((r) => (
              <li key={r.id}>
                <code>{r.id}</code> — {r.why}
              </li>
            ))}
          </ul>
        </div>
      )}


      {!data && !loadError && <p className="settings-hint">读取中…</p>}

      {/* 左侧 kinds 跳转栏（工程台：宽屏那一整条空白不是留白，是没用的版面）——
          栏里只有「哪一类、几枚」，判据与措辞仍住在各组的表头里 */}
      <div className="registry-body" key="body">
        {/* v18 全卡片化 landing：每类一张能力卡（图标/条数/探活/条目速览），点卡聚焦该类 */}
        {!activeKind && (
          <div className="reg-kind-grid">
            {kindCards.map((k) => (
              <div
                key={k.kind}
                className="reg-kind-card"
                role="button"
                tabIndex={0}
                onClick={() => { setKindTab(k.kind); setActiveKind(k.kind); }}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    setKindTab(k.kind);
                    setActiveKind(k.kind);
                  }
                }}
              >
                <div className="reg-kind-head">
                  <span className="reg-kind-icon">{k.icon}</span>
                  <b>{k.label}</b>
                  <span className={`reg-kind-count${k.total ? '' : ' zero'}`}>{k.total}</span>
                </div>
                <p className="reg-kind-desc">{k.desc}</p>
                {(k.live > 0 || k.missing > 0 || k.view) && (
                  <div className="reg-kind-meta">
                    {k.live > 0 && <i className="ok">● {k.live} 在</i>}
                    {k.missing > 0 && <i className="bad">● {k.missing} 不在</i>}
                    {k.view && <span className="registry-chip">现算清单</span>}
                  </div>
                )}
                {k.preview.length > 0 && (
                  <div className="reg-kind-preview">
                    {k.preview.map((n) => (
                      <span key={n}>{n}</span>
                    ))}
                    {k.more > 0 && <span className="more">+{k.more}</span>}
                  </div>
                )}
                <div className="reg-kind-foot">{k.registrable ? '+ 登记这一类' : '查看全部 →'}</div>
              </div>
            ))}
          </div>
        )}

        {activeKind && (
          <button
            className="link reg-back"
            onClick={() => { setKindTab(null); setActiveKind(null); }}
          >
            ← 全部能力
          </button>
        )}

        {groups
          .filter((g) => g.kind === activeKind)
          .map((g) => (
            <section className={`registry-group${g.entries.length === 0 ? ' zero' : ''}`} id={`registry-g-${g.kind}`} key={g.kind}>
              <h3>
                {g.label}
                <span className="registry-count">{g.entries.length} 项</span>
                {g.view && (
                  <span
                    className="registry-chip"
                    title={g.home ? `这一类的成员由${g.home}现算出来：不落盘、也不在这里登记` : '这一类由现算清单生成，不落盘、不登记'}
                  >
                    现算清单
                  </span>
                )}
              </h3>
              {g.entries.length === 0 ? (
                <p className="settings-hint registry-empty">
                  {g.view
                    ? g.home
                      ? `这一类的正身是${g.home}：这里没有可登记的东西，空表就是那一面此刻的读数。`
                      : '这一类由现算清单生成，没有可登记的东西（清单为空就是正读数，不是没配好）。'
                    : `还没有登记的${g.label}——点上方「+ 登记一项」，从表单填进去。`}
                </p>
              ) : (
                <div className="registry-cards">
                  {g.entries.map((e) => {
                    const refs = refCountOf(e);
                    const refList = refRows(e);
                    const readout = health?.get(e.id);
                    const probe = probed[e.id];
                    const pNote = probeNote(probe?.res, probe?.err ?? null);
                    const dot = healthDot(readout);
                    const view = isViewEntry(e);
                    const enabledCell = viewEnabledCell(e, g.home);
                    const when = whenLabels(view, g.home);
                    return (
                      <div key={e.id} className={`registry-card${e.enabled ? '' : ' off'}${detailId === e.id ? ' open' : ''}`}>
                        <div className="registry-card-head">
                          {dot && <span className={`dot ${dot}`} title={healthTitle(readout)} />}
                          <b className="registry-card-name">{e.name}</b>
                          {refs !== null && <span className="registry-chip" title="R2 引用账">被引用 {refs}</span>}
                          <span className="registry-chip">{sourceLabel(e.source)}</span>
                          <span className="registry-card-spacer" />
                          {view ? (
                            <span className="registry-label" title={enabledCell.title}>
                              {enabledCell.text}
                            </span>
                          ) : (
                            <input
                              type="checkbox"
                              checked={e.enabled}
                              disabled={rowBusy(e.id)}
                              title={e.enabled ? '点击停用（留着但不再被选）' : '点击启用'}
                              onChange={() => void toggleEnabled(e)}
                            />
                          )}
                        </div>
                        {e.label && <p className="registry-card-label">{e.label}</p>}
                        <div className="registry-card-ops">
                          {opBusy(e.id, 'toggle') && (
                            <span className="registry-op-note">{e.enabled ? '停用中…' : '启用中…'}</span>
                          )}
                          <button className="link" onClick={() => setDetailId((d) => (d === e.id ? null : e.id))}>
                            {detailId === e.id ? '收起' : '详情'}
                          </button>
                          {view ? null : (
                            <button
                              className="sm ghost danger"
                              disabled={rowBusy(e.id)}
                              onClick={() => void remove(e)}
                              title="删除条目（禁用请用左边的开关）"
                            >
                              {opBusy(e.id, 'delete') ? '删除中…' : (
                                <>
                                  <Icon name="trash" size={12} /> 删除
                                </>
                              )}
                            </button>
                          )}
                        </div>
                        {detailId === e.id && (
                          <dl className="registry-detail">
                            <dt>id</dt>
                            <dd>
                              <code>{e.id}</code>
                              {view
                                ? `（由${g.home ?? '现算清单'}生成，不可改）`
                                : '（不可变；改名=重新登记）'}
                            </dd>
                            <dt>{when.created}</dt>
                            <dd>{formatWhen(e.createdAt) || '—'}</dd>
                            <dt>{when.updated}</dt>
                            <dd>{formatWhen(e.updatedAt) || '—'}</dd>
                            {when.note && (
                              <>
                                <dt>说明</dt>
                                <dd>{when.note}</dd>
                              </>
                            )}
                            {specRows(e.spec).map((row) => (
                              <div key={row.key}>
                                <dt>{row.label}</dt>
                                <dd>{row.text}</dd>
                              </div>
                            ))}
                            {VIEW_HOME_JUMPS[e.kind] && (
                              <>
                                <dt>管理面</dt>
                                <dd>
                                  <button className="link" onClick={() => VIEW_HOME_JUMPS[e.kind]!.go(setView)}>
                                    {VIEW_HOME_JUMPS[e.kind]!.label}
                                  </button>
                                </dd>
                              </>
                            )}
                            {readout && (
                              <>
                                <dt>健康</dt>
                                <dd>
                                  {readout.status === 'live' ? '● 在' : readout.status === 'missing' ? '○ 不在' : `? ${readout.status}`}
                                  ：{readout.detail}
                                  {readout.at ? `（读数时刻 ${formatWhen(readout.at) || readout.at}${readout.cached ? ' · 缓存' : ''}）` : ''}
                                </dd>
                              </>
                            )}
                            <dt>谁在用</dt>
                            <dd>
                              {refList && refList.length > 0 && (
                                <div className="registry-refs">
                                  {refList.map((r) => (
                                    <div key={r.key}>{r.text}</div>
                                  ))}
                                </div>
                              )}
                              <span className={refList === null ? 'registry-detail-note warn' : 'registry-detail-note'}>
                                {refNote(e, refList)}
                              </span>
                            </dd>
                            <dt>探针</dt>
                            <dd>
                              <button
                                className="link"
                                disabled={rowBusy(e.id)}
                                onClick={() => void probeOnce(e)}
                                title="只探这一条（与服务端 5 分钟实探缓存共用）"
                              >
                                {opBusy(e.id, 'probe') ? '探…中' : '探一次'}
                              </button>
                              <button
                                className="link"
                                disabled={rowBusy(e.id)}
                                onClick={() => void probeOnce(e, true)}
                                title="绕开实探缓存现探一遍"
                              >
                                {opBusy(e.id, 'probe-refresh') ? '现探中…' : '现探'}
                              </button>
                            </dd>
                            {pNote && (
                              <>
                                <dt>探针读数</dt>
                                <dd className={probe?.err ? 'registry-detail-fail' : undefined}>{pNote}</dd>
                              </>
                            )}
                            {writeErrors[e.id] && (
                              <>
                                <dt>最近写入失败</dt>
                                <dd className="registry-detail-fail">{writeErrors[e.id]}</dd>
                              </>
                            )}
                          </dl>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          ))}
      </div>
      </>
    </div>
  );
}
