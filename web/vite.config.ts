import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * Vite 配置
 *
 * ⚠️ 双入口（2026-10-05 起）：
 *   - `index.html`   → 应用本体，生产环境由服务端映射到 `/app`
 *   - `landing.html` → 官网首页，生产环境由服务端映射到 `/`
 *
 * 为什么拆成两个入口，而不是在一个 SPA 里用路由判断渲染哪一页：
 *   1. 首页要能"秒开"。独立入口后首页产物只有一张 CSS + 几 KB 脚本，
 *      不必把 React 运行时和整个应用代码一并下载。
 *   2. 首页需要真正的 SEO —— 内容得**写在 HTML 里**，而不是等 JS 渲染出来。
 *   3. 两者互不牵连：改首页不会动应用产物，改应用也不会让首页缓存失效。
 *
 * 注意：这里只负责"构建出两个文件"，**路径映射由服务端负责**（server/src/index.ts）。
 * 本机 `vite dev` 下首页地址是 /landing.html，应用仍是 /index.html。
 */
const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  build: {
    /* 目标：es2020。默认值是 'modules'（更激进），会保留可选链等新语法；
       校园里还有一批 iOS 14/15 的旧机型，降到 es2020 让它们也能跑，
       代价只是产物多几 KB（esbuild 的降级很轻）。 */
    target: 'es2020',
    rollupOptions: {
      input: {
        app: resolve(rootDir, 'index.html'),
        landing: resolve(rootDir, 'landing.html')
      },
      output: {
        /* 把 React 运行时单独切出来。
           为什么：react/react-dom 约 140KB，而业务代码每次发版都变 —— 不拆的话
           用户每次都要重新下载整个包含 React 的 chunk；拆开后 vendor chunk 的
           hash 长期不变，可以一直命中缓存（配合 /assets 的 immutable 头）。 */
        manualChunks: {
          react: ['react', 'react-dom']
        }
      }
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
})
