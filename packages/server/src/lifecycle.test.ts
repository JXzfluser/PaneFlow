import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireInstanceLock, annotateInstanceLock, InstanceLockError, installProcessSurvival } from './lifecycle.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pf-lock-'));
}

describe('v13-S6 dataDir 独占锁', () => {
  it('首实例拿锁→释放→可再拿；活人（父进程 pid）占锁时第二实例拒起且文案带 pid 与出路', () => {
    const dir = tmpDir();
    const lock = acquireInstanceLock(dir);
    expect(fs.existsSync(lock.file)).toBe(true);
    lock.release();
    expect(fs.existsSync(lock.file)).toBe(false);
    const lock2 = acquireInstanceLock(dir);

    // 模拟别的活实例占锁：process.ppid 在测试运行时恒活
    fs.writeFileSync(lock.file, JSON.stringify({ pid: process.ppid, port: 4310, startedAt: 'now' }));
    let caught: unknown;
    try {
      acquireInstanceLock(dir);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InstanceLockError);
    expect((caught as Error).message).toContain(String(process.ppid));
    expect((caught as Error).message).toContain('server.lock');
    lock2.release();
  });

  it('陈旧锁（死 pid）与破烂内容=无主，覆盖接管不拦路', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'server.lock'), JSON.stringify({ pid: 4_294_967_000, startedAt: 'ancient' }));
    const lock = acquireInstanceLock(dir); // 越界 pid 必死
    annotateInstanceLock(lock, 4310);
    lock.release();
    fs.writeFileSync(path.join(dir, 'server.lock'), 'not-json{{{');
    const lock2 = acquireInstanceLock(dir);
    lock2.release();
  });

  it('annotateInstanceLock 只在锁主是自己时补写端口（不许动别人的锁）', () => {
    const dir = tmpDir();
    const lock = acquireInstanceLock(dir);
    annotateInstanceLock(lock, 4399);
    const body = JSON.parse(fs.readFileSync(lock.file, 'utf8')) as { pid: number; port: number };
    expect(body.port).toBe(4399);
    expect(body.pid).toBe(process.pid);
    fs.writeFileSync(lock.file, JSON.stringify({ pid: 4_294_967_000 }));
    annotateInstanceLock(lock, 1234);
    expect((JSON.parse(fs.readFileSync(lock.file, 'utf8')) as { port?: number }).port).toBeUndefined();
    lock.release();
  });
});

describe('v13-S6 进程兜底 handler', () => {
  it('SIGTERM 双发只触发一次优雅停机；unhandledRejection 只落日志不触发退出', async () => {
    const onSignal = vi.fn(async () => {});
    const exitNow = vi.fn();
    const unload = installProcessSurvival({ onSignal, exitNow });
    process.emit('SIGTERM' as never);
    process.emit('SIGTERM' as never);
    await new Promise((r) => setTimeout(r, 20));
    expect(onSignal).toHaveBeenCalledTimes(1);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.emit('unhandledRejection' as never, new Error('boom') as never);
    expect(errSpy).toHaveBeenCalled();
    expect(exitNow).not.toHaveBeenCalled();
    errSpy.mockRestore();
    unload();
  });
});
