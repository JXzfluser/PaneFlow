import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { parseChangelog, recentChangelog, type ChangelogEntry } from '../changelog.js';
import { Icon } from './Icon.js';

/**
 * v19-R6 更新记录卡：数据源 = GET /api/changelog（server 静态读一枚 CHANGELOG.md，
 * 与仓库根 `cat CHANGELOG.md` 同源）。缺文件明说「这版安装没带上」，不空画也不报假错。
 */
export function ChangelogCard() {
  const [state, setState] = useState<{ phase: 'loading' } | { phase: 'ok'; entries: ChangelogEntry[]; source: string } | { phase: 'error'; why: string }>({ phase: 'loading' });

  useEffect(() => {
    let alive = true;
    void api
      .changelog()
      .then((r) => alive && setState({ phase: 'ok', entries: recentChangelog(parseChangelog(r.markdown)), source: r.source }))
      .catch((e) => alive && setState({ phase: 'error', why: String((e as Error).message ?? e) }));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="changelog-card">
      {state.phase === 'loading' && <span className="settings-hint">更新记录读取中…</span>}
      {state.phase === 'error' && <span className="settings-hint">没有更新记录可读：{state.why}</span>}
      {state.phase === 'ok' && (
        <>
          <ol className="changelog-list">
            {state.entries.map((en) => (
              <li key={en.ver} className="changelog-entry">
                <span className="changelog-ver">{en.ver}</span>
                <span className="changelog-title" title={en.items.join(' · ')}>
                  {en.lead || en.title || '（这一版没写句子）'}
                </span>
              </li>
            ))}
          </ol>
          <span className="settings-hint changelog-src" title={state.source}>
            同一枚文件即仓库根 CHANGELOG.md · 悬停版本行可看该版要点
          </span>
        </>
      )}
      {state.phase === 'ok' && state.entries.length === 0 && <span className="settings-hint">CHANGELOG.md 读到了，但里面还没有版本条目。</span>}
    </div>
  );
}

export function ChangelogSection() {
  return (
    <section className="settings-card" id="sec-changelog">
      <h3>
        <Icon name="book" size={13} /> 更新记录
      </h3>
      <ChangelogCard />
    </section>
  );
}
