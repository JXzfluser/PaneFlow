import { describe, expect, it } from 'vitest';
import { buildModelArgs, describeModelDialect } from './model-dialects.js';

/**
 * v19-M1 模型方言表单测：判据钉在 M0 实探的六枚真实方言上——
 * 五枚吃 `--model` 长旗标的引擎逐枚给参数对；qodercli 只认档位枚举，
 * 枚举外的型号名**不注只披露**；未实探 kind 不猜测方言。
 * 姿态=只披露不拦（v13-W1 装备槽同款），这里验的是「注了什么/没注时每句为什么」。
 */

describe('buildModelArgs（M0 实探方言表）', () => {
  it('claude/codex/opencode/pi/hermes：原样注 --model 长旗标', () => {
    for (const kind of ['claude', 'codex', 'opencode', 'pi', 'hermes']) {
      expect(buildModelArgs(kind, 'gpt-4o')).toEqual({ args: ['--model', 'gpt-4o'] });
    }
    // provider/id 拼法（opencode/pi 的目录形状）不加工、原样透传
    expect(buildModelArgs('pi', 'paneflow-gw/deepseek-r1:thinking')).toEqual({
      args: ['--model', 'paneflow-gw/deepseek-r1:thinking'],
    });
  });

  it('qodercli：档位枚举内照注；型号名不注、给一句枚举指路（档位语义不是型号语义）', () => {
    expect(buildModelArgs('qodercli', 'performance')).toEqual({ args: ['--model', 'performance'] });
    const miss = buildModelArgs('qodercli', 'gpt-4o');
    expect(miss.args).toBeUndefined();
    expect(miss.disclosure).toContain('auto/efficient/lite/performance/ultimate');
    expect(miss.disclosure).toContain('gpt-4o');
  });

  it('未实探的在册 kind（如 kimi/gemini）：不猜方言、不注、披露里指两条真路', () => {
    for (const kind of ['kimi', 'gemini', 'grok']) {
      const r = buildModelArgs(kind, 'some-model');
      expect(r.args).toBeUndefined();
      expect(r.disclosure).toContain('未经本机实探');
      expect(r.disclosure).toContain('agentArgs');
    }
  });
});

describe('describeModelDialect（v19 打磨：health 外发的通道读数与注入同一张表）', () => {
  it('五枚 flag 引擎=flag；qodercli=levels 且带值域；其余 kind=none', () => {
    for (const kind of ['claude', 'codex', 'opencode', 'pi', 'hermes']) {
      expect(describeModelDialect(kind)).toEqual({ dialect: 'flag' });
    }
    expect(describeModelDialect('qodercli')).toEqual({
      dialect: 'levels',
      levels: ['auto', 'efficient', 'lite', 'performance', 'ultimate'],
    });
    expect(describeModelDialect('kimi')).toEqual({ dialect: 'none' });
  });

  it('读数与注入永不两把尺：flag→注；levels 枚举内→注、枚举外→只披露；none→只披露', () => {
    expect(buildModelArgs('claude', 'gpt-4o').args).toBeDefined(); // flag
    expect(buildModelArgs('qodercli', 'auto')).toEqual({ args: ['--model', 'auto'] }); // levels 枚举内
    expect(buildModelArgs('qodercli', 'gpt-4o').disclosure).toBeDefined(); // levels 枚举外
    const none = buildModelArgs('kimi', 'gpt-4o'); // none
    expect(none.args).toBeUndefined();
    expect(none.disclosure).toBeDefined();
  });
});
