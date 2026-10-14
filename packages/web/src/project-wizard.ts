import { readFailureNote, writeFailureNote } from './write-outcome.js';

/**
 * 项目新建向导那四发的措辞单源（v19 步骤二十三）。
 *
 * 这一片从前只有底部控制台一句话（`收尾登记失败：…`），画面上就是「按了没反应」，而且失败那一下
 * 连窗都关掉——勾选项跟着人一起没了。更要紧的是它把**两发**请求合成了一句：
 * 「创建项目并扫描」按的是 `POST /api/spaces` 加一发只读扫描，档案其实已经落笔、只有扫描没读到时，
 * 合句就把「建好了」说成「没走通」，人再按一次又往 server 打一发创建。这里按动词分格各说一句，
 * 写的那一发走 `writeFailureNote`，读的那一发走 `readFailureNote`（缺 ≠ 零）。
 */

/** 建档案那一发没成：尾巴说的是落点读不到，绝不替 server 断言盘上没动 */
export function createSpaceFailNote(err: unknown): string {
  return writeFailureNote(
    '项目档案没建成',
    err,
    '档案建没建成不确定，到「项目」页刷新看清单里有没有多出一枚',
  );
}

/** 只读扫描那一发没成（它跟在后面的「再扫一次」也只重问这一发，不再打创建） */
export function probeFailNote(err: unknown): string {
  return readFailureNote('这个目录没扫成', err);
}

/**
 * `/api/env/probe` 对读不到的目录回的是 **200 + `error`** 体键而不是错码（注册中心扫描弹窗同一处形状）。
 * 拿它画「这个目录下没探出仓库/文档/技能」就是拿「不知道」冒充实测结论——两种画法得分开。
 * server 的原话自己已经点明了动词（「这个目录读不到：目录不存在…」），这里不再前缀一句「没读到」：
 * 两处各说一遍同一件事，读起来就是绕口；只追那半句诚实尾巴。
 */
export function probeBodyFailNote(said: string): string {
  return `${said}——这是没读成，不是「这里没东西」`;
}

/** 收尾第一发：勾选项批量登记（rootCwd 由 server 在这一发现场写进档案） */
export function registerFailNote(err: unknown): string {
  return writeFailureNote('这几项没登记进去', err, '这几项进没进档案不确定，刷新看项目档案的读数');
}

/**
 * server 回了 200、`registered` 却是 0，而人明明勾了 N 项：这一发什么都没接进档案。
 * 绿色那句（`scanRegisterOutcome`）在这种数上刻意不发——「已登记 0 项」借的是成功的形状；
 * 这一句替它占位，并拦下自动关窗：人不读完就走，画面就替他把它说成了「已经接进来了」。
 */
export function registerZeroNote(asked: number): string {
  return (
    `这几项没登记进去：server 回了 200，却报 0 项（你要登记的是 ${asked} 项）` +
    '——刷新看项目档案的读数，这一发没成的可能性得由档案说了算。'
  );
}

/** 收尾第二发：装填首发班底。它失败时登记那一发的成句不能跟着被抹掉（组件负责分格摆） */
export function teamSeedFailNote(err: unknown): string {
  return writeFailureNote('首发班底没装填', err, '班底装没装不确定，刷新看项目档案的班底读数');
}

/**
 * 班底那一发的回执：server 交回覆写后的档案，所以位数是它报的、不是这里数的。
 * 回执没带班底那一格时说「以档案读数为准」，不画成 0 位。
 */
export function teamSeedOkNote(count: number | null): string {
  return count === null
    ? '首发班底这一发 server 收了（回执没带班底位序，以项目档案的读数为准）'
    : `首发班底已装填 ${count} 位（server 交回的档案里带的数）`;
}

/** 项目清单那一发读不出：撞没撞 ID 就此判不了，不拿「没读到」说成「不会撞」 */
export function spacesReadNote(err: unknown): string {
  return `${readFailureNote('项目清单读不出', err)}——所以这一枚 ID 撞没撞档案判不了`;
}

/**
 * ID 撞车预检（第①步，边打字边说）。判据不是这里发明的：`POST /api/spaces` 对在册 id 走的是
 * **upsert**（`Store.createSpace` 只把那枚档案的 `name` 覆掉），所以两个名字 slugify 到同一枚 id 时，
 * 第二下发「创建」不是报错，而是**给已有的项目改名**。清单读不出（null）就一句不说——
 * 「没读到」不等于「不会撞」；同名不喊（那就是同一枚档案）。
 */
export function idCollisionNote(
  spaces: { id: string; name: string }[] | null,
  id: string,
  name: string,
): string | null {
  if (!spaces || !id || !name.trim()) return null;
  const clash = spaces.find((s) => s.id === id);
  if (!clash || clash.name.trim() === name.trim()) return null;
  return (
    `项目 ID「${id}」已经是「${clash.name}」的档案——server 认 ID 不认名，` +
    `再按「创建项目并扫描」会把它的名字改成「${name.trim()}」。换个名字，或者关掉向导直接用那一枚。`
  );
}
