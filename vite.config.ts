import type { Plugin } from 'vite'
import { execFileSync, execSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

import vueDevTools from 'vite-plugin-vue-devtools'

interface ThemeManifest {
  short?: unknown
  version?: unknown
}

const THEME_SHORT_REGEX = /^[\w-]+$/
const themeJsonPath = resolve(__dirname, 'theme.json')
// 开发服务器把 /api 和 WebSocket 代理到这个 hub，不设时代理到本机 9911
const hubTarget = process.env.MONITOR_HUB || 'http://127.0.0.1:9911'

// CFSM 主题代理只转发 /assets/*；将 public 资源路径统一映射到该目录。
const CFSM_THEME_ASSET_PATH_REGEX = /(['"])\/(images|data)\//g
const DIST_TEXT_FILE_REGEX = /\.(?:html|js|css|json)$/

function cfsmThemeAssetPaths(): Plugin {
  return {
    name: 'cfsm-theme-asset-paths',
    transformIndexHtml(html) {
      return html.replace(CFSM_THEME_ASSET_PATH_REGEX, '$1/assets/$2/')
    },
  }
}

function rewriteDistAssetUrls(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      rewriteDistAssetUrls(path)
      continue
    }

    if (!entry.isFile() || !DIST_TEXT_FILE_REGEX.test(entry.name))
      continue

    const source = readFileSync(path, 'utf-8')
    const rewritten = source.replace(CFSM_THEME_ASSET_PATH_REGEX, '$1/assets/$2/')
    if (rewritten !== source)
      writeFileSync(path, rewritten)
  }
}

function readThemeManifest(): ThemeManifest {
  if (!existsSync(themeJsonPath))
    throw new Error('theme.json not found')

  return JSON.parse(readFileSync(themeJsonPath, 'utf-8')) as ThemeManifest
}

function getThemeVersion(): string {
  const version = readThemeManifest().version

  if (typeof version !== 'string' || !version.trim())
    throw new TypeError('theme.json does not contain a top-level string version field')

  return version.trim()
}

function getCommitHash(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  }
  catch {
    return 'unknown'
  }
}

/**
 * Vite 插件：构建后打包极简探针主题
 * hub 安装时在包的根目录找 theme.json，所以文件直接放在根目录，不套一层目录：
 * theme.tar.gz
 * ├── theme.json
 * ├── preview.png
 * └── dist/
 */
function monitorThemePackage(): Plugin {
  return {
    name: 'monitor-theme-package',
    apply: 'build',
    closeBundle: () => {
      const short = readThemeManifest().short
      if (typeof short !== 'string' || !THEME_SHORT_REGEX.test(short))
        throw new TypeError('theme.json short must use letters, digits, - or _')

      const distDir = resolve(__dirname, 'dist')
      if (!existsSync(distDir)) {
        console.log('[monitor-theme] dist directory not found, skipping package')
        return
      }

      // CFSM 从仓库子目录读取 dist/index.html，并且只代理 /assets/*。
      // Vite 默认把 public/images、public/data 放在 dist 根目录，这里复制一份到 assets。
      const assetDir = resolve(distDir, 'assets')
      mkdirSync(assetDir, { recursive: true })
      for (const directory of ['images', 'data']) {
        const sourceDir = resolve(distDir, directory)
        if (existsSync(sourceDir))
          cpSync(sourceDir, resolve(assetDir, directory), { recursive: true, force: true })
      }

      // 在构建完成后重写产物中的 URL，避免 Vue 编译阶段把 public 资源误解析为模块导入。
      rewriteDistAssetUrls(distDir)

      const stage = mkdtempSync(join(tmpdir(), 'monitor-theme-'))
      const entries = ['theme.json', 'dist']
      cpSync(themeJsonPath, join(stage, 'theme.json'))
      const previewPath = resolve(__dirname, 'preview.png')
      if (existsSync(previewPath)) {
        cpSync(previewPath, join(stage, 'preview.png'))
        entries.push('preview.png')
      }
      cpSync(distDir, join(stage, 'dist'), { recursive: true })

      const output = resolve(__dirname, 'theme.tar.gz')
      execFileSync('tar', ['-czf', output, '-C', stage, ...entries])
      rmSync(stage, { recursive: true, force: true })
      const sizeMB = (statSync(output).size / 1024 / 1024).toFixed(2)
      console.log(`[monitor-theme] Created theme.tar.gz (${short} v${getThemeVersion()}, ${sizeMB} MB)`)
    },
  }
}

export default defineConfig({
  define: {
    __BUILD_VERSION__: JSON.stringify(getThemeVersion()),
    __BUILD_GIT_HASH__: JSON.stringify(getCommitHash()),
  },
  plugins: [
    cfsmThemeAssetPaths(),
    vue(),
    vueDevTools(),
    tailwindcss(),
    monitorThemePackage(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: hubTarget,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    target: ['es2018', 'safari15.4'],
    cssTarget: 'safari15.4',
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          'vue-vendor': ['vue', 'vue-router', 'pinia'],
          'echarts': ['echarts', 'vue-echarts'],
          'reka-ui': ['reka-ui'],
          'vueuse': ['@vueuse/core'],
          'v3-services': [
            './src/services/history.service.ts',
            './src/services/metrics.service.ts',
            './src/services/request.service.ts',
            './src/services/cache.service.ts',
            './src/utils/osImageHelper.ts',
            './src/utils/metricSeries.ts',
            './src/composables/useNodePingDisplay.ts',
          ],
        },
      },
    },
  },
})
