import type { RegistryEntry } from '@paneflow/shared';
import { readReferenceIndex, refsForEntry, type ReferenceIndex, type RegistryReferrer } from './registry-refs.js';
import { registryViewEntries } from './registry-view.js';

/**
 * v14 A5-5a「删除侧的闸」。
 *
 * R2 那条「被引用不许删」长在**注册表的三个写动词**上（`api/registry-routes.ts`）。可三枚正身在盘上的
 * 视图 kind（`role`/`template`/`gateway-profile`）恰恰**没有**写动词——注册表对它们一律拒写，正身住在
 * 角色库名册、`graphs/`、`gateway.json` 那三张盘上。于是那三处各自的删除面从来没查过引用账：
 * 从画布删掉一张还在被别的图 `pipeline.template` 指着的图、从角色库删掉一枚还在被班底绑着的岗、
 * 从网关那一面删掉一枚还被项目钉着的档，今天都不拦。这一片把闸装到**正身面**上，注册表那侧一行不改。
 *
 * 三条姿态要说清，它们是本片全部的取舍：
 *  1. **判据不开第二份**：谁是引用者、哪串算指到这一枚，全部走 `buildReferenceIndex` 那张现成的账
 *     （`matchedEntries` → descriptor 的 `refKeys`）。这里只做「取哪一格」和「渲成人话」，不比对字符串。
 *  2. **读不出 ≠ 没人用**：扫描本身抛错（模板目录读不动等）一律 **500 不放行**。这条是 R2 最危险的
 *     假绿落点——降级成「零引用」就等于给删除开了绿灯，所以宁可报不出，不装读得出。
 *  3. **两种「镜子里没有这一枚」要分开**：正身读得出时按条目 id 取它的引用；正身脏到读不出条目
 *     （图画不出来）时，那些指着这串的裸串在账上落在 `dangling` 一格——同样能拦，但拒句必须明说
 *     「镜子读不出这一枚」，不装作拿的是条目读数。
 */

/** 正身在盘上、因而有「自己的删除面」的三枚视图 kind（另三枚视图 kind 的正身是代码，没有删除面） */
export type OnDiskViewKind = 'role' | 'template' | 'gateway-profile';

export type DeleteGuard = { ok: true } | { ok: false; code: 400 | 500; error: string };

/** 引用面的中文对照（同 `api/registry-routes.ts` 那张表，本片把它收成一处——两句拒答迟早分叉） */
const FACE_CN: Record<RegistryReferrer['face'], string> = { space: '项目', role: '角色', template: '模板', gateway: '网关档' };

/** 「删不动的原因」必须看得见：逐条列是谁在用、用在哪个键（人按这个位置去改，不用猜） */
export function referencedWhy(action: string, name: string, refs: RegistryReferrer[], note?: string): string {
  const list = refs.map((r) => `${FACE_CN[r.face]}「${r.name}」的 ${r.via}`).join('、');
  const head = note ?? '';
  return `${head}「${name}」还被 ${refs.length} 处引用着（${list}），${action}会把这些引用变成悬挂引用——先改掉那几处再来。`;
}

export interface DeleteGuardOptions {
  /**
   * 引用者自己那一格的 id。`refsFromGraph` 把 referrer 的 id 写成**图内 name**（因为
   * `pipeline.template` 指的正是那枚串），而模板条目的机器值是**文件名**——删一张图时它自己发出的边
   * 随文件一起消失，不构成悬挂，所以要把那一格剔掉。
   *
   * **只给图内 name，不给文件名**：文件名不是任何 referrer 的 id（referrer 一律按图内 name 登记），
   * 把它放进黑名单就会把「另一张图的 name 恰好等于被删的文件名」那笔**真引用**一起洗掉。
   * 残留边界：剔的依据是名字而不是文件路径（`RawReference` 没有逐文件出处），两张图同名时仍可能多剔一笔——
   * 那要落成「引用者带来源文件」才是彻底解法，不在本片。
   *
   * 只有 `template` 用得上（岗与档都不自己引用自己：`refsFromRole` 不发 role 类裸串，
   * 网关盘那一格只有 `current`，另有专列判据）。
   */
  selfIds?: string[];
  /** 动词措辞：删除/清账，拒句跟着调用方说的那件事走 */
  action?: string;
}

/**
 * 一批待删条目对引用账的结论。整批一次扫描（`PUT /api/roles` 一次可以撤掉好几枚岗，
 * 逐枚重扫盘面是 N 倍 IO 且没有任何额外读数）。
 *
 * `gateway-profile` 有一格**必须**从引用者里剔掉：`via:'current'`。`current` 不是「谁选择了这一档」，
 * 而是「网关那张盘此刻生效的是谁」——删掉 current 那档，`deleteGatewayProfile` 本来就顺延到剩下第一档，
 * 边不会悬挂。拿它拦删除就是拿文档级读数冒充人的决定（同 v13-V1「机检账只数引擎实跑得了的」那把尺）。
 * 真正的引用者是 `SpaceProfile.gatewayProfile` 那枚钉档（`face:'space'`），那一格照拦。
 */
export function guardOnDiskDeletes(
  dataDir: string,
  kind: OnDiskViewKind,
  targets: string[],
  opts: DeleteGuardOptions = {},
): DeleteGuard {
  const action = opts.action ?? '删除';
  const selfIds = new Set((opts.selfIds ?? []).map((s) => s.trim()).filter(Boolean));
  let index: ReferenceIndex;
  let entries: RegistryEntry[];
  try {
    // 这三枚 kind 的成员只可能来自视图现算（`entries.json` 里永远没有它们，见 shared 的视图 kind 清单），
    // 所以这里直接读视图，不接 `RegistryStore`——接了就是把「镜子的两条读盘路」摆成第二个事实源。
    entries = registryViewEntries({ dataDir }).entries;
    index = readReferenceIndex(dataDir, entries);
  } catch (err) {
    return { ok: false, code: 500, error: `引用账扫不出：${(err as Error).message}（读不出不等于没人用，这次不放行）` };
  }

  for (const raw of targets) {
    const target = typeof raw === 'string' ? raw.trim() : '';
    if (!target) continue; // 没有机器值就没有可指的东西：那是调用方那一侧的形状问题，不在这里替它编一条引用
    const mine = entries.find((e) => e.kind === kind && e.name === target);
    const found = mine
      ? refsForEntry(index, mine.id)
      : (index.dangling.find((d) => d.kind === kind && d.target === target)?.by ?? []);
    const refs = found.filter((r) => {
      if (kind === 'gateway-profile' && r.via === 'current') return false;
      return !(kind === 'template' && r.face === 'template' && selfIds.has(r.id));
    });
    if (!refs.length) continue;
    return {
      ok: false,
      code: 400,
      error: referencedWhy(
        action,
        target,
        refs,
        mine ? undefined : `这一枚在注册表的镜子里读不出条目（正身那张盘上它脏了或重名被去重了），下面这几串裸串指的是它的机器值原文：`,
      ),
    };
  }
  return { ok: true };
}
