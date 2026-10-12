import { useCallback, useEffect, useRef, useState } from 'react';

export type NoteTone = 'fail' | 'warn';

/**
 * 动作点上那一句读数的形状。两种寿命分得很清：
 * - **预检句**（「无法启动：…（当前 0 个）」「请先填写工作目录」）描述的是*此刻这一格*，
 *   所以带 `ctx`——按下那一刻把那一格的读数记下来，它一变这句就成了旧话，必须自己撤下。
 *   画布修好了还挂着「开始节点一个都没有」，比根本没有读数更坏。
 * - **写失败句**（「模板没保存（画布上的改动还在）」）与**未配置提示**说的是刚才那一按/那一面配置，
 *   是过去的事实或别处的状态，不带 `ctx`——后续编辑不洗它，只被下一次按下顶掉。
 * 谁都不靠计时器：撤不撤只比读数，绝不数秒。
 */
export interface ActionNote {
  tone: NoteTone;
  text: string;
  ctx?: string;
}

/** 纯判据：这条读数现在还算不算数（预检句跟着它所描述那一维的现值走，其余一律留着）。 */
export function keepActionNote(cur: ActionNote | null, ctx: string): ActionNote | null {
  // 「这一维现在读起来是空」也是一枚正读数：空串必须参与比对，只有没带 ctx 才是不跟读数走
  if (cur?.ctx === undefined) return cur;
  return cur.ctx === ctx ? cur : null;
}

/**
 * 一个动作位一句读数。`ctx` 是调用侧自己打包的那一维（或几维）现值——判据住在 `keepActionNote`，
 * 这里只负责「读数一变就重判」，所以同一页面可以开多个互不干扰的读数位。
 */
export function useActionNote(ctx: string) {
  const [note, setNote] = useState<ActionNote | null>(null);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  useEffect(() => {
    setNote((cur) => keepActionNote(cur, ctx));
  }, [ctx]);

  /** 预检没过：这句描述此刻的 `ctx`，它一变就作废 */
  const notePrecheck = useCallback(
    (text: string, tone: NoteTone = 'fail') => setNote({ tone, text, ctx: ctxRef.current }),
    [],
  );
  /** 那一按的结果（失败/未配置）：不随后续编辑作废 */
  const noteResult = useCallback(
    (text: string, tone: NoteTone = 'fail') => setNote({ tone, text }),
    [],
  );
  const clearNote = useCallback(() => setNote(null), []);

  return { note, notePrecheck, noteResult, clearNote };
}
