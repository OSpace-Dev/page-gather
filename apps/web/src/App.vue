<script setup lang="ts">
import { NConfigProvider, NMessageProvider, NDialogProvider, zhCN, dateZhCN } from 'naive-ui'
import { onBeforeUnmount, ref } from 'vue'
const online = ref(navigator.onLine)
function connection() { online.value = navigator.onLine }
window.addEventListener('online',connection)
window.addEventListener('offline',connection)
onBeforeUnmount(()=>{window.removeEventListener('online',connection);window.removeEventListener('offline',connection)})
const theme = { common: { primaryColor: '#2563eb', primaryColorHover: '#1d4ed8', primaryColorPressed: '#1e40af', fontSize: '16px', borderRadius: '8px' } }
</script>
<template><n-config-provider :locale="zhCN" :date-locale="dateZhCN" :theme-overrides="theme"><n-message-provider><n-dialog-provider><router-view v-if="online" /><main v-else class="offline-public"><h1>当前处于离线状态</h1><p>联网后可重新查看工作台。离线不显示账号资料、通知或 README；个人页面已清空，不从缓存恢复。</p></main></n-dialog-provider></n-message-provider></n-config-provider></template>
