import fs from 'node:fs';
import path from 'node:path';

/**
 * v13-S6 进程级存活与单实例守卫。
 * 背景（v13 对账·批判轮补账）：全仓 process.on 零命中——一次未捕获 Promise 拒绝即当场死；
 * 无 dataDir 独占锁——发行包上误敲一次子命令即起第二实例，在构造期把在飞单一律改判 failed 踩账。
 * 口径：兜底 handler 只落日志不假装恢复；服务化（systemd/pm2/launchd）是用户操作系统的事，这里不造壳。
 */

export class InstanceLockError extends Error {}

export interface InstanceLock {
  readonly file: string;
  release(): void;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // 信号 0=只做存在性探测
    return true;
  } catch (err) {
    // EPERM=存在但没权限；ESRCH=不存在
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * dataDir 独占锁（pidfile 形态）。同 dataDir 第二实例拒起并指路；
 * 死进程残留/内容破烂=陈旧锁，覆盖并明说（不静默吞）。
 */
export function acquireInstanceLock(dataDir: string): InstanceLock {
  const file = path.join(dataDir, 'server.lock');
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const prev = JSON.parse(raw) as { pid?: number; port?: number; startedAt?: string };
    if (typeof prev.pid === 'number' && prev.pid !== process.pid && pidAlive(prev.pid)) {
      throw new InstanceLockError(
        `另一个 PaneFlow server（pid ${prev.pid}${prev.port ? `，端口 ${prev.port}` : ''}，起于 ${prev.startedAt ?? '时间未知'}）正持有 ${dataDir}。` +
          `拒绝启动第二实例——两实例互踩账本。要停掉它：kill ${prev.pid}；确认是幻影锁：删 ${file}`,
      );
    }
    if (raw.trim()) {
      console.warn('[paneflow] 发现陈旧/破烂锁文件，覆盖接管：', file);
    }
  } catch (err) {
    if (err instanceof InstanceLockError) throw err;
    // 读不到/不存在=无锁，继续
  }
  const payload = JSON.stringify({ pid: process.pid, port: undefined, startedAt: new Date().toISOString() });
  const write = () => fs.writeFileSync(file, payload + '\n');
  write();
  return {
    file,
    release(): void {
      try {
        const cur = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: number };
        if (cur.pid === process.pid) fs.rmSync(file, { force: true });
      } catch {
        fs.rmSync(file, { force: true });
      }
    },
  };
}

/** 记录 port 进锁文件（listen 成功后补写，让拒绝文案能指名端口） */
export function annotateInstanceLock(lock: InstanceLock, port: number): void {
  try {
    const cur = JSON.parse(fs.readFileSync(lock.file, 'utf8')) as Record<string, unknown>;
    if (cur.pid !== process.pid) return;
    cur.port = port;
    fs.writeFileSync(lock.file, JSON.stringify(cur) + '\n');
  } catch {
    /* 锁文件不可写不影响主流程 */
  }
}

/**
 * 进程级兜底：unhandledRejection/uncaughtException 落日志（不假装恢复；
 * uncaughtException 走 exitNow——状态已不可信，体面退出不硬撑）；
 * SIGTERM/SIGINT 走 onSignal 优雅停机（掐 agent→关 workspace→flush 账本由调用方注入）。
 * 返回卸载函数（测试用）。
 */
export function installProcessSurvival(opts: {
  onSignal: (signal: 'SIGTERM' | 'SIGINT') => Promise<void>;
  exitNow: (code: number) => void;
}): () => void {
  let shuttingDown = false;
  const rejection = (reason: unknown) => {
    console.error('[paneflow] unhandledRejection（只落日志，不假装恢复）:', reason);
  };
  const exception = (err: Error) => {
    console.error('[paneflow] uncaughtException（状态不可信，落日志后即时退出）:', err);
    opts.exitNow(1);
  };
  const signal = (name: 'SIGTERM' | 'SIGINT') => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[paneflow] 收到 ${name}：优雅停机（掐 agent→关 workspace→flush 账本）`);
    void opts.onSignal(name).catch((err) => {
      console.error('[paneflow] 优雅停机失败（仍退出）:', err);
    });
  };
  process.on('unhandledRejection', rejection);
  process.on('uncaughtException', exception);
  const term = () => signal('SIGTERM');
  const int = () => signal('SIGINT');
  process.on('SIGTERM', term);
  process.on('SIGINT', int);
  return () => {
    process.off('unhandledRejection', rejection);
    process.off('uncaughtException', exception);
    process.off('SIGTERM', term);
    process.off('SIGINT', int);
  };
}
