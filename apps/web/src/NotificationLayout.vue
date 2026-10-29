<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, useMessage } from 'naive-ui'
import AppNavigation from './AppNavigation.vue'
import PwaPanel from './PwaPanel.vue'
import { logoutCurrentDevice } from './push'
defineProps<{title:string}>()
const expanded = ref(false), busy = ref(false), router = useRouter(), message = useMessage()
async function logout() {
  if (busy.value) return
  busy.value = true
  try { const warnings = await logoutCurrentDevice(); await router.replace({path:'/login',query:warnings.length ? {logoutWarning:'1'} : {}}) } catch(e) { message.error(e instanceof Error ? e.message : '退出失败，请重试。') } finally { busy.value = false }
}
</script>
<template><div class="shell"><aside :class="['sidebar',{expanded}]"><div class="brand">PAGE GATHER<span>采集工作台</span></div><app-navigation /><div class="sidebar-foot">站内通知始终可用<br>推送须主动授权</div></aside><div class="workspace"><header class="topbar"><n-button class="menu-toggle" :aria-expanded="expanded" aria-label="展开或收起导航" @click="expanded=!expanded">☰</n-button><span>{{ title }}</span><n-button quaternary :loading="busy" @click="logout">退出登录</n-button></header><main class="content"><div class="page-heading"><div><h1>{{ title }}</h1><p class="muted">站内消息与设备推送相互独立。</p></div></div><pwa-panel /><slot /></main></div></div></template>
