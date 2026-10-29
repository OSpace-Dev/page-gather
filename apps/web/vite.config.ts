import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { publicShell } from './pwaBuild.mjs'
export default defineConfig({ plugins: [vue(), publicShell()] })
