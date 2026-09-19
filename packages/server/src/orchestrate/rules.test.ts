import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { effectiveRules, globToRegExp, matchRules, type SpaceRule } from './rules.js';

describe('effectiveRules（旧字段兼容迁移）', () => {
  it('conventionFiles 迁移为无作用域条目，与 rules 合并且按 file 去重（rules 优先）', () => {
    const rules: SpaceRule[] = [{ file: 'a.md', repo: 'x' }, { file: 'dup.md' }];
    const out = effectiveRules({ rules, conventionFiles: ['dup.md', 'b.md'] });
    expect(out).toEqual([{ file: 'a.md', repo: 'x' }, { file: 'dup.md' }, { file: 'b.md' }]);
  });

  it('只有旧字段时行为等价于全量注入形', () => {
    expect(effectiveRules({ conventionFiles: ['AGENTS.md'] })).toEqual([{ file: 'AGENTS.md' }]);
    expect(effectiveRules({})).toEqual([]);
  });

  it('残缺条目（无 file）被剔除', () => {
    expect(effectiveRules({ rules: [{ note: 'x' }, { file: '' }, { file: 'ok.md' }] as SpaceRule[] })).toEqual([
      { file: 'ok.md' },
    ]);
  });
});

describe('matchRules（作用域匹配）', () => {
  const root = path.join(path.sep, 'space');
  const r = (over: Partial<SpaceRule>): SpaceRule => ({ file: 'f.md', ...over });

  it('无作用域规则恒命中（含仓外与未知 cwd）', () => {
    const rules = [r({})];
    expect(matchRules(rules, root, path.join(root, 'anything'))).toHaveLength(1);
    expect(matchRules(rules, root, '/elsewhere')).toHaveLength(1);
    expect(matchRules(rules, undefined, undefined)).toHaveLength(1);
  });

  it('repo 规则按目录包含命中，兄弟仓不误伤', () => {
    const rules = [r({ repo: 'alpha' })];
    expect(matchRules(rules, root, path.join(root, 'alpha', 'svc'))).toHaveLength(1);
    expect(matchRules(rules, root, path.join(root, 'alpha'))).toHaveLength(1);
    expect(matchRules(rules, root, path.join(root, 'alphabet'))).toHaveLength(0);
    expect(matchRules(rules, root, path.join(root, 'beta'))).toHaveLength(0);
    expect(matchRules(rules, root, '/tmp/alpha')).toHaveLength(0); // 仓外不算进仓
  });

  it('pathsGlob 对相对主仓根的路径匹配（* 不跨段，** 跨段）', () => {
    expect(matchRules([r({ pathsGlob: 'packages/*/src' })], root, path.join(root, 'packages/server/src')))
      .toHaveLength(1);
    expect(matchRules([r({ pathsGlob: 'packages/*/src' })], root, path.join(root, 'packages/a/b/src')))
      .toHaveLength(0);
    expect(matchRules([r({ pathsGlob: 'docs/**' })], root, path.join(root, 'docs/a/b.md'))).toHaveLength(1);
    expect(matchRules([r({ pathsGlob: 'docs/**' })], root, path.join(root, 'docs'))).toHaveLength(0);
  });

  it('repo+glob 同给取交集；无主仓根时作用域规则一律不命中', () => {
    const rules = [r({ repo: 'alpha', pathsGlob: 'alpha/test/**' })];
    expect(matchRules(rules, root, path.join(root, 'alpha', 'test', 'unit'))).toHaveLength(1);
    expect(matchRules(rules, root, path.join(root, 'alpha', 'src'))).toHaveLength(0);
    expect(matchRules([r({ repo: 'alpha' })], undefined, '/somewhere/alpha')).toHaveLength(0);
  });
});

describe('globToRegExp', () => {
  it('转义正则特殊字符且全串匹配', () => {
    const re = globToRegExp('a+b/c.d');
    expect(re.test('a+b/c.d')).toBe(true);
    expect(re.test('aab/cxd')).toBe(false);
    expect(globToRegExp('a?c').test('abc')).toBe(true);
    expect(globToRegExp('a?c').test('a/c')).toBe(false);
  });
});
