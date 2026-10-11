import { describe, expect, it } from 'vitest';
import { modelCoverNote, type ModelDialectRead } from './model-note.js';

/** v19 打磨：起单前「模型这值会不会被注」的可见面——判据来自 server health 外发读数，前端只陈列（R4） */

const dialects: Record<string, ModelDialectRead> = {
  pi: { dialect: 'flag' },
  claude: { dialect: 'flag' },
  qodercli: { dialect: 'levels', levels: ['auto', 'efficient', 'lite', 'performance', 'ultimate'] },
  kimi: { dialect: 'none' },
};

describe('modelCoverNote', () => {
  it('没配模型 / flag 引擎 / 档位引擎的枚举值 → 零判词（不没事刷屏）', () => {
    expect(modelCoverNote(undefined, 'pi', dialects)).toBeNull();
    expect(modelCoverNote('  ', 'qodercli', dialects)).toBeNull();
    expect(modelCoverNote('gpt-4o', 'claude', dialects)).toBeNull();
    expect(modelCoverNote('performance', 'qodercli', dialects)).toBeNull();
  });

  it('档位引擎吃了型号名 → 一句档位枚举指路；未实探 kind → 一句「不会注入」+ 真路指路', () => {
    expect(modelCoverNote('gpt-4o', 'qodercli', dialects)).toContain('auto/efficient/lite/performance/ultimate');
    const none = modelCoverNote('gpt-4o', 'kimi', dialects)!;
    expect(none).toContain('不会注入');
    expect(none).toContain('agentArgs');
  });

  it('读数不可得一律不画判词：旧 server 缺键 / kind 不在册 / 引擎还没解析出来', () => {
    expect(modelCoverNote('gpt-4o', 'kimi', undefined)).toBeNull();
    expect(modelCoverNote('gpt-4o', 'ghost-kind', dialects)).toBeNull();
    expect(modelCoverNote('gpt-4o', undefined, dialects)).toBeNull();
  });
});
