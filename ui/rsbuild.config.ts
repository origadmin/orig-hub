import { defineConfig } from '@rsbuild/core'
import { pluginReact } from '@rsbuild/plugin-react'
import path from 'path'

const projectRoot = path.resolve(__dirname)

export default defineConfig({
  plugins: [pluginReact()],
  source: {
    entry: {
      index: './src/main.tsx',
    },
  },
  html: {
    template: './index.html',
  },
  resolve: {
    alias: {
      '@': './src',
    },
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
  },
  tools: {
    rspack: {
      resolve: {
        modules: [projectRoot, 'node_modules'],
      },
      watchOptions: {
        ignored: /wailsjs/,
      },
    },
  },
  output: {
    distPath: {
      root: 'dist',
    },
    assetPrefix: '/',
  },
  server: {
    port: 3000,
    strictPort: true,
  },
  dev: {
    hmr: true,
    liveReload: true,
  },
})
