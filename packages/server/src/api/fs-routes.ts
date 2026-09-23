import path from 'node:path';
import fs from 'node:fs';
import { FastifyInstance } from 'fastify';

const MD_SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'target']);

function listDirSafe(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** B10: read-only filesystem helpers — discovery of conventions/skills and a
 * constrained directory browser (home-rooted, directories only). */
export function registerFsRoutes(
  app: FastifyInstance,
  resolveRoot: (space: string | undefined) => string | null,
): void {
  // discover: markdown docs + skill files under the Space 的主仓根（root 不再接受客户端任意值）
  app.get<{ Querystring: { space?: string } }>('/api/fs/discover', async (req, reply) => {
    const root = resolveRoot(req.query.space);
    if (!root) return reply.code(400).send({ error: '当前项目未配置主仓根目录' });
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return reply.code(400).send({ error: `目录不存在：${root}` });
    }
    const markdowns: string[] = [];
    const skills: string[] = [];
    const repos: string[] = [];
    for (const d of listDirSafe(root)) {
      if (d.name.startsWith('.')) continue;
      const full = path.join(root, d.name);
      if (d.isFile() && d.name.endsWith('.md')) {
        markdowns.push(d.name);
        continue;
      }
      if (d.isDirectory() && fs.existsSync(path.join(full, '.git'))) {
        repos.push(d.name);
      }
      if (d.isDirectory() && !MD_SKIP.has(d.name)) {
        // one level deep: docs/*.md, skills/*.md(x)
        for (const sub of listDirSafe(full)) {
          if (sub.isFile() && (sub.name.endsWith('.md') || sub.name.endsWith('.mdx'))) {
            const rel = `${d.name}/${sub.name}`;
            if (d.name === 'skills') skills.push(rel);
            else markdowns.push(rel);
          }
          if (sub.isDirectory() && sub.name === 'skills') {
            for (const sk of listDirSafe(path.join(full, sub.name))) {
              if (sk.isDirectory()) skills.push(`skills/${sk.name}/SKILL.md`);
              else if (sk.name.endsWith('.md')) skills.push(`skills/${sk.name}`);
            }
          }
        }
      }
    }
    return { root, markdowns: markdowns.sort(), skills: skills.sort(), repos: repos.sort() };
  });

  // browse: directories under a path (home-rooted) for the root picker
  app.get<{ Querystring: { path?: string } }>('/api/fs/browse', async (req, reply) => {
    const home = path.join(process.env.HOME ?? '/', 'Documents');
    const dir = req.query.path && path.isAbsolute(req.query.path) ? req.query.path : home;
    const entries = listDirSafe(dir)
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
    return { dir, parent: path.dirname(dir) !== dir ? path.dirname(dir) : null, entries };
  });
}
