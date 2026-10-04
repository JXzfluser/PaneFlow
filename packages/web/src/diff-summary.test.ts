import { describe, expect, it } from 'vitest';
import { parseUnifiedDiff, summarizeDiff } from './diff-summary.js';

const SAMPLE = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 111..222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,3 +1,5 @@',
  ' unchanged',
  '-old line',
  '+new line',
  '+another new line',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,1 @@',
  '+brand new',
  'diff --git a/assets/logo.png b/assets/logo.png',
  'index 333..444 100644',
  'GIT binary patch',
  'literal 10',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('按 +++ 侧归文件、逐 hunk 计增删，二进制文件单列', () => {
    const s = parseUnifiedDiff(SAMPLE);
    expect(s.files.map((f) => f.file)).toEqual(['src/app.ts', 'src/new.ts', 'assets/logo.png']);
    expect(s.files[0]).toMatchObject({ added: 2, removed: 1, binary: false });
    expect(s.files[1]).toMatchObject({ added: 1, removed: 0 });
    expect(s.files[2]).toMatchObject({ binary: true });
    expect(s.totalAdded).toBe(3);
    expect(s.totalRemoved).toBe(1);
  });

  it('没有 diff 头如实给空（不把正文猜成文件名）', () => {
    expect(parseUnifiedDiff('随便一段日志 +++ b/fake.ts')).toEqual({ files: [], totalAdded: 0, totalRemoved: 0 });
    expect(parseUnifiedDiff('')).toEqual({ files: [], totalAdded: 0, totalRemoved: 0 });
  });

  it('上下文行/头部杂讯不计入增删', () => {
    const s = parseUnifiedDiff(
      [
        'diff --git a/a.md b/a.md',
        '--- a/a.md',
        '+++ b/a.md',
        '@@ -2,5 +2,5 @@',
        ' context',
        '+kept',
        '-dropped',
        'no prefix trailing noise',
      ].join('\n'),
    );
    expect(s.files[0]).toEqual({ file: 'a.md', added: 1, removed: 1, binary: false });
  });
});

describe('summarizeDiff', () => {
  it('有人话摘要与「无改动」两态', () => {
    expect(summarizeDiff(parseUnifiedDiff(SAMPLE))).toBe('3 个文件 · +3 −1');
    expect(summarizeDiff(parseUnifiedDiff(''))).toBe('无改动');
  });
});
