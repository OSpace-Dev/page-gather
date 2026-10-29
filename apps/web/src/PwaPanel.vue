<script setup lang="ts">
import { NAlert, NButton } from 'naive-ui'
import { applyUpdateFromClick, installAvailable, installed, installFromClick, pwaError, updateAvailable } from './pwa'
</script>
<template><n-alert v-if="updateAvailable" type="info" class="gap" title="新版本已就绪">不会自动刷新或覆盖未保存的表单。<div><n-button @click="applyUpdateFromClick">确认更新并刷新</n-button></div></n-alert><n-alert v-if="pwaError" type="warning" class="gap">{{ pwaError }}</n-alert><div v-if="installAvailable && !installed" class="gap"><n-button @click="installFromClick">安装采集工作台</n-button></div></template>
