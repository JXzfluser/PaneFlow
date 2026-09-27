import {
  REGISTRY_KINDS,
  requirementIssueOf,
  type DagGraph,
  type RegistryEntry,
} from '@paneflow/shared';
import { matchesTarget } from './registry-refs.js';

/**
 * v14-T3 起单前预检：模板自带的 `requires` 槽对着本机注册表解析，**缺项 fail-closed**。
 *
 * 判据只有一份（本文件）：HTTP 面（`GET /api/registry/check`）、引擎起单口（`startRun`）、CLI 与
 * 网页模板卡全部照它的返回渲染——谁都不自己数、不自己判（铁律 R4）。
 * 这一条是有教训的：预检与起单若是两把尺，就会出现「预检说全绿、起单当场红」，那比没预检更糟。
 *
 * 三条姿态，与 R2 引用索引同形：
 *  1. **只有已迁进注册表的 kind 才判死活**（今天＝`REGISTRY_KINDS`：登记项 `model`/`skill`（A5-1）/`rule`（A5-2）/`repo`（A5-3）/`mcp`（T4），
 *     加三枚视图 kind `agent-kind`（A3-2）、`node-type`（T1）、`check-type`（A5-4））。指向 `role`/`template`/… 的槽落 `unjudged` 只披露：
 *     表里压根没有这一类，判「不存在」＝拿空白冒充断言。
 *  2. **形状不认的槽落 `malformed` 且 `ok=false`**——判不了就不放行。脏形状正常走不到这里
 *     （`validateDag` 在写入面就拒），但盘面手改得动，读端不能因为脏项而假绿。
 *  3. 匹配用 R2 那把尺（`matchesTarget` → Descriptor 的 `refKeys`）：声明写整枚 id、id 的 slug 段、
 *     还是 spec 里的型号原值，三种写法都算命中——预检与引用账必须同一把尺。
 */

/** 一条槽的声明（`requires` 项的合法形状；`kind` 必填，其余可选） */
export interface RequirementSlot {
  kind: string;
  id?: string;
  hint?: string;
}

/** 逐槽落点读数（渲染面按它画 ✓/✗/?，不自己比对三份清单猜命中） */
export interface RequirementSlotReadout extends RequirementSlot {
  /** `ok` 命中 / `missing` 死缺 / `unjudged` 这一类还判不了 / `malformed` 声明形状不认 */
  verdict: 'ok' | 'missing' | 'unjudged' | 'malformed';
  /** server 的一句人话：命中时说明用的哪一枚，其余是缺因 */
  why: string;
  /** 命中时解析到的条目 id；没命中整键不给（宁缺毋假，不拿空串冒充「用了没东西」） */
  entryId?: string;
}

/** 模板卡那一行「需要：模型 1 · 技能 2」的分组读数：计数与中文标签全在 server 算 */
export interface RequirementNeed {
  kind: string;
  /** 人话组名（未知 kind 原样画，不替未来的新 kind 猜中文名） */
  label: string;
  /** 这一类声明了几槽 */
  declared: number;
  /** 其中判得了死活的槽（已迁 kind 且形状认）——`declared - judged` 即「这一类还判不了」 */
  judged: number;
  /** 其中缺的槽数（>0 时卡片画缺口✗） */
  gaps: number;
}

export interface TemplateRequirementCheck {
  template: string;
  /** 逐槽读数（按声明顺序）；`[]` 是正读数「这模板没带槽」 */
  slots: RequirementSlotReadout[];
  /** 「需要：模型 1 · 技能 2」那一行的料 */
  need: RequirementNeed[];
  /** 死缺：指向已迁 kind 却解析不到可用条目 */
  missing: RequirementSlotReadout[];
  /** 指向尚未迁进注册表的 kind：只披露，绝不判死活（姿态 1） */
  unjudged: RequirementSlotReadout[];
  /** 形状不认：无法判定，按不放行处理（姿态 2） */
  malformed: RequirementSlotReadout[];
  /** 起单放不放行：无 `missing` 且无 `malformed` 才 true（`unjudged` 不拦） */
  ok: boolean;
}

export interface RequirementCheckView {
  /** 回显：这一份读数按哪个项目算（缺省=default）。**不参与命中判定**，见 `spaceNote` */
  space: string;
  /**
   * 诚实标注：槽命中只看注册表全局，项目名只用于指路文案。
   * 带作用域的 kind 已经进表了（`skill` 自 A5-1），所以这一枚**不是**「等迁入」的空头支票，
   * 而是一条划界：作用域住在引用账与探针，不在预检——`requires` 槽没有写项目名的位置，
   * 拿当前空间去收窄会把「本机有这篇能力」判成「本项目没登记」，那是替作者编约束。
   */
  spaceNote: string;
  at: string;
  templates: TemplateRequirementCheck[];
}

/**
 * kind → 人话组名。**全仓唯一一份 this 表**（决议「单一词表」）：预检的 `need[].label`、
 * `GET /api/registry` 的 `kindLabels` 都从这一处出——网页与 CLI 拿它渲染，不再各抄一份
 * （两张表迟早分叉措辞，而没人会去比对两张措辞表）。
 * 值域不封死：注册表日后加 kind，这里没跟上就原样画——把未知 kind 画成猜来的中文名是假账。
 */
const KIND_CN: Record<string, string> = {
  model: '模型',
  skill: '技能',
  rule: '规则',
  repo: '仓库',
  'gateway-profile': '网关档',
  role: '角色',
  'agent-kind': 'Agent 引擎',
  'check-type': '机检',
  'node-type': '节点类型',
  mcp: 'MCP 服务',
  template: '模板',
  channel: '通道',
  'artifact-kind': '产物',
};

export function requirementKindLabel(kind: string): string {
  return KIND_CN[kind] ?? kind;
}

const isJudged = (kind: string): boolean => (REGISTRY_KINDS as readonly string[]).includes(kind);

/** 形状认得的项 → 槽原文（形状不认的交给 `requirementIssueOf` 说为什么，这里不猜） */
function asSlot(raw: unknown): RequirementSlot | null {
  if (requirementIssueOf(raw)) return null;
  const item = raw as { kind: string; id?: string; hint?: string };
  const slot: RequirementSlot = { kind: item.kind.trim() };
  if (item.id) slot.id = item.id;
  if (item.hint) slot.hint = item.hint;
  return slot;
}

/**
 * 一张模板 → 预检读数。**纯函数**：`entries` 由调用方给（注册表整表），本模块不开第二条读盘路
 * （R2 的同一理由：同一份数据两个读端＝迟早对不上）。
 */
export function checkGraphRequirements(graph: DagGraph, entries: RegistryEntry[]): TemplateRequirementCheck {
  const slots: RequirementSlotReadout[] = [];

  for (const raw of graph.requires ?? []) {
    const slot = asSlot(raw);
    if (!slot) {
      const kind =
        raw && typeof raw === 'object' && typeof (raw as { kind?: unknown }).kind === 'string'
          ? (raw as { kind: string }).kind
          : '(空)';
      const hint =
        raw && typeof raw === 'object' && typeof (raw as { hint?: unknown }).hint === 'string'
          ? (raw as { hint: string }).hint
          : undefined;
      slots.push({
        kind,
        ...(hint ? { hint } : {}),
        verdict: 'malformed',
        why: `声明形状不认：${requirementIssueOf(raw) ?? '未知毛病'}`,
      });
      continue;
    }
    if (!isJudged(slot.kind)) {
      slots.push({
        ...slot,
        verdict: 'unjudged',
        why: `「${requirementKindLabel(slot.kind)}」这一类还没迁进注册表，判不了死活（只披露不拦）`,
      });
      continue;
    }
    // 可用＝这一类里**启用中**的条目（`enabled:false` 是「留着但不再被选」，拿它凑槽就是假绿）
    const usable = entries.filter((e) => e.kind === slot.kind && e.enabled);
    const wanted = slot.id;
    const hit = wanted ? usable.find((e) => matchesTarget(e, wanted)) : usable[0];
    slots.push(
      hit
        ? { ...slot, verdict: 'ok', why: `用「${hit.name}」`, entryId: hit.id }
        : {
            ...slot,
            verdict: 'missing',
            why: slot.id
              ? `注册表里没有可用（启用中）的「${requirementKindLabel(slot.kind)}」条目指向「${slot.id}」`
              : `注册表里一枚可用的「${requirementKindLabel(slot.kind)}」条目都没有`,
          },
    );
  }

  const pick = (verdict: RequirementSlotReadout['verdict']): RequirementSlotReadout[] =>
    slots.filter((s) => s.verdict === verdict);
  const missing = pick('missing');
  const malformed = pick('malformed');

  // 分组按声明首现顺序排（作者写的顺序就是他关心的顺序）；`malformed` 的 kind 可能压根没写对，
  // 那一格仍要显出来（否则「需要：」一行会少一类），但按「判不了」计（judged 不累加）
  const needs = new Map<string, RequirementNeed>();
  for (const s of slots) {
    const cur = needs.get(s.kind) ?? {
      kind: s.kind,
      label: requirementKindLabel(s.kind),
      declared: 0,
      judged: 0,
      gaps: 0,
    };
    cur.declared += 1;
    if (isJudged(s.kind) && s.verdict !== 'malformed') cur.judged += 1;
    if (s.verdict === 'missing') cur.gaps += 1;
    needs.set(s.kind, cur);
  }

  return {
    template: graph.name,
    slots,
    need: [...needs.values()],
    missing,
    unjudged: pick('unjudged'),
    malformed,
    ok: missing.length === 0 && malformed.length === 0,
  };
}

/**
 * 拒单文案（引擎 `startRun` 与未来的调用方共用一份）：一句人话 + 逐槽带缺因，指路到「注册中心」。
 * 走的是 v13-E2 `DISPATCH_NO_AGENT_ERROR` 那条显式 send 路——CLI 只读 `body.error`（`cli/client.ts`），
 * 交给 Fastify 默认序列化的话指路文案会掉进 `message` 里没人看见。
 */
export function requirementGapWhy(check: TemplateRequirementCheck): string {
  const gaps = [...check.missing, ...check.malformed];
  const list = gaps
    .map((g) => `${g.kind}${g.id ? ` → ${g.id}` : ''}（${g.why}${g.hint ? ` · 模板备注：${g.hint}` : ''}）`)
    .join('、');
  return `模板「${check.template}」的能力槽没补齐：${list}——先在「注册中心」登记缺的那几项（或改掉模板的 requires）再起单。`;
}
