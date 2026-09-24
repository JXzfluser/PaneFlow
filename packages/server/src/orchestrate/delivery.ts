/**
 * v13-B1 交付约定块（delivery）：空间档案的「家规」声明位。
 * 交付约定五要素——拉出基点 / 分支命名 / PR 目标 / 门禁 / 驳回流程——里本片装前三样 +
 * 人闸声明（gates）+ 备注（note）；驳回流程由既有件表达（K2 回边），不新造。
 * 条目形状对齐 rules 的挂载点先例（SpaceRule.repo 同款匹配语义：相对主仓根的仓库目录名，
 * 一仓一副）。占位符（`{issue}`/`{version}`…）当不透明字符串存——解析与引擎消费全在 B2，
 * 本片引擎刻意不读 delivery。
 */

/** 条目允许键集合：未知键即拒（拼错字段=家规静默失效，宁拒不错放） */
const DELIVERY_KEYS = ['repo', 'branchFrom', 'branchName', 'prTarget', 'gates', 'note'] as const;

export interface DeliveryRule {
  /** 相对空间主仓根的仓库目录名；缺省=全空间副（B2 按仓匹配消费，一仓一副） */
  repo?: string;
  /** 拉出基点分支（如 "main"；可含占位符，B1 不解析） */
  branchFrom: string;
  /** 分支名模板（如 "fix/issue-{issue}"；占位符原样存） */
  branchName: string;
  /** PR 目标分支（如 "release/v{version}"；可含占位符） */
  prTarget: string;
  /** 人闸名声明（有哪几道、叫什么）；执行件仍是既有 approval 节点，此处只入册 */
  gates?: string[];
  /** 为什么/什么时候守这副家规 */
  note?: string;
}

/**
 * PUT /api/spaces/:id 的 delivery 机检：合法返回 null；非法返回一句人话错误（400 文案）。
 * 姿态对齐 rules 既有校验（http.ts PUT：数组 + 每项对象 + 必备字段字符串），并按
 * 「宁拒不错放」收紧——必填三字段非空、未知键拒绝、repo/gates/note 给出时严类型。
 */
export function validateDelivery(raw: unknown): string | null {
  const SHAPE = 'delivery 必须是 {branchFrom, branchName, prTarget, repo?, gates?, note?} 条目数组';
  if (!Array.isArray(raw)) return SHAPE;
  for (let i = 0; i < raw.length; i += 1) {
    const x = raw[i];
    if (!x || typeof x !== 'object' || Array.isArray(x)) {
      return `${SHAPE}；第 ${i + 1} 项不是对象`;
    }
    const item = x as Record<string, unknown>;
    const unknown = Object.keys(item).filter((k) => !(DELIVERY_KEYS as readonly string[]).includes(k));
    if (unknown.length) {
      return `delivery 第 ${i + 1} 项含未知键：${unknown.join('/')}（只认 ${DELIVERY_KEYS.join('/')}）`;
    }
    for (const key of ['branchFrom', 'branchName', 'prTarget'] as const) {
      const v = item[key];
      if (typeof v !== 'string' || !v.trim()) {
        return `delivery 第 ${i + 1} 项的 ${key} 必须是非空字符串`;
      }
    }
    if (item.repo !== undefined && (typeof item.repo !== 'string' || !item.repo.trim())) {
      return `delivery 第 ${i + 1} 项的 repo 给出时须为非空字符串（相对主仓根的仓库目录名）`;
    }
    if (
      item.gates !== undefined &&
      (!Array.isArray(item.gates) || item.gates.some((g) => typeof g !== 'string' || !g.trim()))
    ) {
      return `delivery 第 ${i + 1} 项的 gates 必须是非空字符串数组（人闸只声明，执行件用既有 approval 节点）`;
    }
    if (item.note !== undefined && typeof item.note !== 'string') {
      return `delivery 第 ${i + 1} 项的 note 必须是字符串`;
    }
  }
  return null;
}
