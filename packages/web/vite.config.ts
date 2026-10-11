import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

//  dev 代理目标可换（并行验证实例用：PF_API_TARGET=http://127.0.0.1:4399 pnpm dev:web）
const API = process.env.PF_API_TARGET ?? 'http://127.0.0.1:4310';

// 写方法的 CSRF 闸（server `isAllowedOrigin`）比的是 Origin 与请求 Host 两个头。
// Vite 代理默认把 Host 改写成目标端口，于是浏览器 Origin=本 dev 端口、Host=server 端口 → 每次保存都 403。
// changeOrigin:false 让 Host 原样传下去，Origin 与 Host 相等 → 同源判定成立，dev 写操作不必配 PF_CORS_ORIGINS。
const KEEP_HOST = { target: API, changeOrigin: false };

export default defineConfig({
  plugins: [react()],
  define: {
    __PF_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    host: '127.0.0.1',
    port: 4311,
    proxy: {
      '/api': KEEP_HOST,
      '/ws': { ...KEEP_HOST, target: API.replace(/^http/, 'ws'), ws: true },
    },
  },
});
