<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { NAlert, NButton, NDrawer, NDrawerContent, NTag } from 'naive-ui'
import { api, date, identified, page, safeUrl, text } from './api'
import type { Entry, Run } from './api'
import { runProjectSnapshot } from './runSnapshot'

const props = defineProps<{ run: Run | null; entry: Entry | null }>()
const emit = defineEmits<{ close: []; openEntity: [id: string] }>()
const snapshot = computed(() => {
  if (!props.entry) return null
  const entry = props.run?.snapshot?.entries.find(item => item.key === props.entry?.key) ?? props.entry
  return runProjectSnapshot(props.run, entry)
})
const entityId = ref(''), lookupState = ref<'loading'|'found'|'absent'|'error'>('absent')
let lookupGeneration = 0
async function findEntity() {
  const requestGeneration = ++lookupGeneration
  const current = snapshot.value
  entityId.value = ''
  if (!current || current.state !== 'available') { lookupState.value = 'absent'; return }
  lookupState.value = 'loading'
  try {
    // 单页关键词查询只用于补充实体历史入口，不影响运行快照的展示。
    const result = page(await api(`/entities?limit=200&q=${encodeURIComponent(current.sourceKey)}`), identified)
    if (requestGeneration !== lookupGeneration) return
    const match = result.items.find(item => item.sourceKey === current.sourceKey)
    entityId.value = match?.id ?? ''
    lookupState.value = match ? 'found' : 'absent'
  } catch { if (requestGeneration === lookupGeneration) lookupState.value = 'error' }
}
watch([() => props.run?.id, () => props.entry?.key, () => snapshot.value?.sourceKey, () => snapshot.value?.state], () => void findEntity(), { immediate: true })
onBeforeUnmount(() => { lookupGeneration++ })
</script>

<template>
  <n-drawer :show="!!entry" :width="820" @update:show="show=>{if(!show)emit('close')}">
    <n-drawer-content title="本次运行 · 项目 README" closable>
      <template v-if="snapshot">
        <h2>{{ snapshot.sourceKey }}</h2>
        <n-tag type="info">运行快照</n-tag>
        <p class="muted">采集于 {{ date(snapshot.observedAt) }} · 本文来自所选运行。</p>
        <p><a v-if="safeUrl(snapshot.sourceUrl)" :href="safeUrl(snapshot.sourceUrl)" target="_blank" rel="noopener noreferrer">在来源网站打开 ↗</a></p>
        <n-alert v-if="snapshot.state==='pending'" type="info">该项目尚未采集，本次运行暂无 README 正文。</n-alert>
        <n-alert v-else-if="snapshot.state==='failed'" type="warning">该项目本次采集失败，暂无本次 README 正文。</n-alert>
        <n-alert v-else-if="snapshot.state==='missing'" type="warning">本次运行没有可读取的项目正文。请返回运行详情刷新后重试。</n-alert>
        <template v-else>
          <n-alert v-if="snapshot.readme?.status==='not_found'" type="info">本次采集确认来源页面没有 README。</n-alert>
          <template v-else-if="snapshot.readme && typeof snapshot.readme.text==='string'">
            <div class="readme-meta"><n-tag>README · 页面文本</n-tag><a v-if="safeUrl(snapshot.readme.sourceUrl)" :href="safeUrl(snapshot.readme.sourceUrl)" target="_blank" rel="noopener noreferrer">README 来源 ↗</a></div>
            <p class="muted">{{ snapshot.readme.truncated===true?'来源正文已截断。':snapshot.readme.truncated===null?'来源页面是否截断未知。':'本次采集的 README 正文。' }}</p>
            <pre class="readme" v-text="snapshot.readme.text" />
          </template>
          <div class="gap-top">
            <n-button v-if="lookupState==='found'" @click="emit('openEntity',entityId)">查看实体资料与版本历史</n-button>
            <p v-else-if="lookupState==='loading'" class="muted" role="status">正在查询可用的实体历史…</p>
            <p v-else-if="lookupState==='absent'" class="muted">暂无对应实体历史，仍可查看本次运行保留的正文。</p>
            <template v-else><p class="muted">实体历史查询暂不可用，本次运行正文已展示。</p><n-button @click="findEntity">重试查询历史</n-button></template>
          </div>
        </template>
      </template>
    </n-drawer-content>
  </n-drawer>
</template>
