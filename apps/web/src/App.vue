<script setup lang="ts">
import { NConfigProvider, NMessageProvider, NDialogProvider, zhCN, dateZhCN } from 'naive-ui'
const theme = { common: { primaryColor: '#2563eb', primaryColorHover: '#1d4ed8', primaryColorPressed: '#1e40af', fontSize: '16px', borderRadius: '8px' } }
</script>
<template><n-config-provider :locale="zhCN" :date-locale="dateZhCN" :theme-overrides="theme"><n-message-provider><n-dialog-provider><router-view /></n-dialog-provider></n-message-provider></n-config-provider></template>
