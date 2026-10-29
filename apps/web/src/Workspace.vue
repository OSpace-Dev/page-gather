<script setup lang="ts">
import { computed, h, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NCard, NDataTable, NDrawer, NDrawerContent, NEmpty, NForm, NFormItem, NInput, NInputNumber, NProgress, NSelect, NSpace, NSwitch, NTag, useDialog, useMessage } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { active, api, date, identified, label, page, record, row, run, safeUrl, task, text } from './api'
import RunSnapshotDrawer from './RunSnapshotDrawer.vue'
import { defaultSchedule, parseScheduler, runScheduleText, scheduleDate, scheduleError, scheduleReason, scheduleStatusText, timezoneOptions } from './schedule'
import type { SchedulerState } from './schedule'
import type { Entity, Entry, Row, Run, Task } from './api'
const route = useRoute(), router = useRouter(), message = useMessage(), dialog = useDialog()
const section = computed(() => String(route.meta.section ?? 'overview'))
const titles: Record<string,string> = { overview:'工作台概览', tasks:'任务与手动采集', runs:'运行记录', entities:'项目资料库' }
const nav = [{ key:'overview', title:'概览' }, { key:'tasks', title:'任务 / 手动采集' }, { key:'runs', title:'运行记录' }, { key:'entities', title:'项目资料库' }]
const collapsed = ref(false), loading = ref(false), error = ref(''), pollError = ref(''), detailError = ref('')
const tasks = ref<Task[]>([]), runs = ref<Run[]>([]), entities = ref<Entity[]>([]), workers = ref<Row[]>([]), healthy = ref(false)
const taskCursor = ref<string|null>(null), runCursor = ref<string|null>(null), entityCursor = ref<string|null>(null)
const selectedSnapshotEntry = ref<Entry|null>(null)
const selectedRun = ref<Run|null>(null), entity = ref<Row|null>(null), versions = ref<Row[]>([]), selectedVersion = ref<Row|null>(null)
const query = ref(''), entityType = ref(''), editTask = ref<Task|null>(null), saving = ref(false), starting = ref<string|null>(null), cancelling = ref(false)
const form = ref({ name:'', enabled:true, maxRepos:25, itemDelayMs:5000, language:'', spokenLanguage:'', schedule:defaultSchedule() })
const scheduler = ref<SchedulerState|null>(null), schedulerError = ref('')
const scheduleValidation = computed(() => scheduleError(form.value.schedule))
const scheduleSaveHint = computed(() => !form.value.schedule.enabled ? '每日计划关闭；保存不会自动执行。手动执行不会开启计划。' : !form.value.enabled ? '每日计划将保存为开启，但任务已停用，不会自动运行。以后启用任务时只安排未来时刻。' : '每日计划将开启；只安排未来时刻，不补启用前的历史日程。')
const retryKeys = new Map<string,string>()
let timer: ReturnType<typeof setTimeout> | undefined
let generation = 0, detailGeneration = 0, disposed = false
const latestCompleted = computed(() => [...runs.value].filter(r => ['SUCCEEDED','PARTIAL'].includes(r.status)).sort((a,b) => text(b.finishedAt ?? b.createdAt).localeCompare(text(a.finishedAt ?? a.createdAt)))[0])
const currentRunId = computed(() => typeof route.query.runId === 'string' ? route.query.runId : '')
const currentEntityId = computed(() => typeof route.query.entityId === 'string' ? route.query.entityId : '')
const previewUrl = computed(() => {
  const configured = safeUrl(import.meta.env.VITE_BROWSER_PREVIEW_URL)
  if (configured) return configured
  return ['localhost','127.0.0.1','[::1]'].includes(location.hostname) ? 'http://127.0.0.1:16080/' : undefined
})
const manual = computed(() => workers.value.some(w => ['MANUAL','MANUAL_REQUESTED'].includes(text(w.mode))))
const entries = computed(() => selectedRun.value?.status === 'SKIPPED' ? [] : selectedRun.value?.snapshot?.entries ?? [])
const progress = computed(() => {
  const p = selectedRun.value?.progress
  return p && typeof p.total === 'number' && p.total > 0 && typeof p.completed === 'number' ? Math.max(0, Math.min(100, Math.round(p.completed / p.total * 100))) : undefined
})
function report(e: unknown) { return e instanceof Error ? e.message : '操作失败，请重试。' }
function stopPoll() { if (timer) clearTimeout(timer); timer = undefined }
async function fetchRun(id: string, requestGeneration = detailGeneration) {
  const result = run(row(await api(`/runs/${encodeURIComponent(id)}`)).run)
  if (!disposed && requestGeneration === detailGeneration && currentRunId.value === id) selectedRun.value = result
}
function schedulePoll() {
  stopPoll()
  if (disposed || document.hidden || pollError.value || !selectedRun.value || !active(selectedRun.value)) return
  const id = selectedRun.value.id, requestGeneration = detailGeneration
  timer = setTimeout(async () => {
    try {
      await fetchRun(id, requestGeneration)
      if (requestGeneration !== detailGeneration || disposed) return
      if (selectedRun.value && !active(selectedRun.value)) {
        await loadRuns()
      }
    } catch (e) { if (requestGeneration === detailGeneration && !disposed) pollError.value = report(e) }
    if (requestGeneration === detailGeneration) schedulePoll()
  }, 3000)
}
async function loadDetails() {
  const requestGeneration = ++detailGeneration
  stopPoll(); pollError.value = ''; detailError.value = ''; selectedRun.value = null; entity.value = null; versions.value = []; selectedVersion.value = null
  try {
    if (currentRunId.value) await fetchRun(currentRunId.value, requestGeneration)
    if (currentEntityId.value) {
      const result = row(await api(`/entities/${encodeURIComponent(currentEntityId.value)}?limit=200`))
      const item = identified(result.entity)
      if (!Array.isArray(result.versions) || !result.versions.every(record)) throw new Error('项目版本数据格式不匹配。')
      const history: Row[] = [...result.versions]
      let cursor = typeof result.nextCursor === 'string' ? result.nextCursor : null
      const seenCursors = new Set<string>()
      while (cursor && requestGeneration === detailGeneration && !disposed) {
        if (seenCursors.has(cursor)) throw new Error('版本列表游标重复，请重试。')
        seenCursors.add(cursor)
        const p = page(await api(`/entities/${encodeURIComponent(currentEntityId.value)}/versions?limit=200&cursor=${encodeURIComponent(cursor)}`), row)
        history.push(...p.items); cursor = p.nextCursor
      }
      if (requestGeneration === detailGeneration && !disposed) {
        entity.value = item
        history.reverse()
        versions.value = history
        selectedVersion.value = history.find(v => v.id === item.currentVersionId) ?? history[0] ?? null
      }
    }
  } catch(e) { if (requestGeneration === detailGeneration && !disposed) detailError.value = report(e) }
  if (requestGeneration === detailGeneration) schedulePoll()
}
async function retryPoll() {
  if (!currentRunId.value) return
  pollError.value = ''
  const requestGeneration = detailGeneration
  try { await fetchRun(currentRunId.value, requestGeneration) } catch(e) { if (requestGeneration === detailGeneration) pollError.value = report(e) }
  if (requestGeneration === detailGeneration) schedulePoll()
}
function visibility() { if (document.hidden) stopPoll(); else schedulePoll() }
document.addEventListener('visibilitychange', visibility)
async function loadScheduler(requestGeneration = generation) {
  if (section.value !== 'overview') return
  try {
    const value = parseScheduler(await api('/scheduler'))
    if (!disposed && requestGeneration === generation) { scheduler.value = value; schedulerError.value = '' }
  } catch (e) {
    if (!disposed && requestGeneration === generation) { scheduler.value = null; schedulerError.value = report(e) }
  }
}
async function load() {
  const requestGeneration = ++generation
  loading.value = true; error.value = ''
  const requests = [
    api('/health').then(v => { const h = row(v); if (h.status !== 'ok') throw new Error('服务健康检查未通过。'); if (requestGeneration === generation) healthy.value = true }).catch(e=>{ if (requestGeneration === generation) healthy.value=false; throw e }),
    api('/workers').then(v => { const p = page(v, row); if (requestGeneration === generation) workers.value = p.items }),
    api('/tasks?limit=50').then(v => { const p = page(v, task); if (requestGeneration === generation) { tasks.value = p.items; taskCursor.value = p.nextCursor } }),
    loadRuns(requestGeneration),
    loadScheduler(requestGeneration)
  ]
  if (section.value === 'entities') requests.push(fetchEntities(false, requestGeneration))
  const results = await Promise.allSettled(requests)
  if (requestGeneration !== generation || disposed) return
  const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failure) error.value = report(failure.reason)
  loading.value = false
}
function refresh() { void load(); if (currentRunId.value || currentEntityId.value) void loadDetails() }
async function loadRuns(requestGeneration = generation) {
  // 列表游标按创建顺序递增，遍历后排序才能在刷新后展示真正最近完成的结果。
  const all: Run[] = []
  let cursor: string | null = null
  const seenCursors = new Set<string>()
  do {
    if (cursor && seenCursors.has(cursor)) throw new Error('运行列表游标重复，请重试。')
    if (cursor) seenCursors.add(cursor)
    const p: { items: Run[]; nextCursor: string | null } = page(await api(`/runs?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`), run)
    all.push(...p.items); cursor = p.nextCursor
  } while (cursor && requestGeneration === generation && !disposed)
  if (requestGeneration === generation && !disposed) { runs.value = all.sort((a,b)=>text(b.createdAt).localeCompare(text(a.createdAt))); runCursor.value = null }
}
async function fetchEntities(more = false, requestGeneration = generation) {
  const params = new URLSearchParams({ limit:'50' })
  if (query.value.trim()) params.set('q', query.value.trim())
  if (entityType.value.trim()) params.set('type', entityType.value.trim())
  if (more && entityCursor.value) params.set('cursor', entityCursor.value)
  const p = page(await api(`/entities?${params}`), identified)
  if (requestGeneration === generation && !disposed) { entities.value = more ? [...entities.value, ...p.items] : p.items; entityCursor.value = p.nextCursor }
}
async function searchEntities(more = false) {
  if (loading.value) return
  loading.value = true; error.value = ''
  try { await fetchEntities(more) } catch(e) { error.value = report(e) } finally { loading.value = false }
}
async function more(kind: 'tasks'|'runs') {
  if (loading.value) return
  loading.value = true
  try {
    const cursor = kind === 'tasks' ? taskCursor.value : runCursor.value
    const v = await api(`/${kind}?limit=50&cursor=${encodeURIComponent(cursor ?? '')}`)
    if (kind === 'tasks') { const p = page(v, task); tasks.value.push(...p.items); taskCursor.value = p.nextCursor }
    else { const p = page(v, run); runs.value.push(...p.items); runCursor.value = p.nextCursor }
  } catch(e) { error.value = report(e) } finally { loading.value = false }
}
function openRun(id: string) { void router.push({ path:'/runs', query:{runId:id} }) }
function openEntity(id: string) { void router.push({ path: route.path, query:{ ...route.query, entityId:id } }) }
function closeEntity() { const q = {...route.query}; delete q.entityId; void router.replace({query:q}) }
function edit(t: Task) {
  editTask.value = t
  form.value = { name:t.name, enabled:t.enabled, maxRepos: typeof t.config.maxRepos === 'number' ? t.config.maxRepos : 25, itemDelayMs: typeof t.config.itemDelayMs === 'number' ? t.config.itemDelayMs : 5000, language:text(t.config.language,''), spokenLanguage:text(t.config.spokenLanguage,''), schedule:{ ...t.schedule } }
}
async function saveTask() {
  if (!editTask.value || saving.value) return
  const f = form.value
  if (!f.name.trim() || !Number.isInteger(f.maxRepos) || f.maxRepos < 1 || f.maxRepos > 100 || !Number.isInteger(f.itemDelayMs) || f.itemDelayMs < 3000 || f.itemDelayMs > 3600000 || (f.language && !/^[a-z0-9][a-z0-9+#.-]{0,49}$/.test(f.language)) || (f.spokenLanguage && !/^[a-z]{2,3}(-[A-Z]{2})?$/.test(f.spokenLanguage))) { message.error('请检查名称、数量（1–100）、间隔（3000–3600000 毫秒）与语言格式。'); return }
  if (scheduleValidation.value) { message.error(scheduleValidation.value); return }
  const config = { ...editTask.value.config, since:'daily', maxRepos:f.maxRepos, itemDelayMs:f.itemDelayMs }
  const optional = config as Row
  if (f.language) optional.language = f.language; else delete optional.language
  if (f.spokenLanguage) optional.spokenLanguage = f.spokenLanguage; else delete optional.spokenLanguage
  saving.value = true
  try { await api(`/tasks/${encodeURIComponent(editTask.value.id)}`, 'PATCH', { name:f.name.trim(), enabled:f.enabled, config, schedule:{ enabled:f.schedule.enabled, time:f.schedule.time, timezone:f.schedule.timezone } }); editTask.value = null; message.success(`任务参数已保存。${scheduleSaveHint.value}`); await load() } catch(e) { message.error(report(e)) } finally { saving.value = false }
}
async function start(t: Task) {
  if (starting.value) return
  starting.value = t.id
  try {
    let key = retryKeys.get(t.id)
    if (!key) { key = crypto.randomUUID(); retryKeys.set(t.id, key) }
    const created = run(row(await api(`/tasks/${encodeURIComponent(t.id)}/runs`, 'POST', {}, key)).run)
    retryKeys.delete(t.id); openRun(created.id)
  } catch(e) { message.error(`${report(e)} 再次点击将安全重试同一次请求。`) } finally { starting.value = null }
}
function cancelRun() {
  const r = selectedRun.value
  if (!r || cancelling.value) return
  dialog.warning({ title:'取消本次采集？', content:'将停止后续采集，已入库的结果仍然保留。', positiveText:'确认取消', negativeText:'继续采集', onPositiveClick:async () => {
    cancelling.value = true
    try { await api(`/runs/${encodeURIComponent(r.id)}/cancel`, 'POST', {}); message.success('已提交取消请求'); await retryPoll() } catch(e) { message.error(report(e)) } finally { cancelling.value = false }
  } })
}
async function logout() { try { await api('/auth/logout','POST',{}); await router.replace('/login') } catch(e) { message.error(report(e)) } }
function viewEntry(e: Entry) { selectedSnapshotEntry.value = e }
function viewSnapshotEntity(id: string) {
  selectedSnapshotEntry.value = null
  openEntity(id)
}
function statusTag(value: unknown) { const s = text(value); return h(NTag, { size:'small', bordered:false, type: ['SUCCEEDED','completed'].includes(s) ? 'success' : ['FAILED','failed'].includes(s) ? 'error' : ['PARTIAL','pending','RECOVERING'].includes(s) ? 'warning' : 'info' }, () => label(s)) }
const runColumns: DataTableColumns<Run> = [ {title:'运行',key:'id',render:r => h(NButton,{text:true,type:'primary',onClick:()=>openRun(r.id)},()=>r.id)}, {title:'状态',key:'status',render:r=>statusTag(r.status)}, {title:'触发 / 计划时刻',key:'trigger',render:r=>h('div',[h('b',label(r.trigger ?? 'manual')),h('p',{class:'muted table-description'},runScheduleText(r))])}, {title:'创建时间',key:'createdAt',render:r=>date(r.createdAt)}, {title:'结束时间',key:'finishedAt',render:r=>date(r.finishedAt)} ]
const entryColumns: DataTableColumns<Entry> = [ {title:'#',key:'rank',width:60}, {title:'项目 / README',key:'key',render:e=>h('div',[h(NButton,{text:true,type:'primary',onClick:()=>viewEntry(e)},()=>e.key),h('p',{class:'muted table-description'},text(e.description,''))])}, {title:'语言',key:'language',render:e=>text(e.language)}, {title:'Stars',key:'stars',render:e=>text(e.stars)}, {title:'今日变化',key:'dailyChange',render:e=>text(e.dailyChange)}, {title:'状态',key:'status',render:e=>statusTag(e.status)} ]
const entityColumns: DataTableColumns<Entity> = [ {title:'项目',key:'sourceKey',render:e=>h(NButton,{text:true,type:'primary',onClick:()=>openEntity(e.id)},()=>text(e.sourceKey,text(e.name,e.id)))}, {title:'类型',key:'entityType',render:e=>text(e.entityType)}, {title:'最近采集',key:'lastSeenAt',render:e=>date(e.lastSeenAt)} ]
const summary = computed(() => {
  const s = selectedRun.value?.resultSummary
  if (!record(s)) return []
  const names: Record<string,string> = { items:'采集项目', created:'新增', changed:'变更', unchanged:'未变更', completeness:'完整性', disposition:'入库结果' }
  const values: Record<string,string> = { complete:'完整', partial:'部分完成', applied:'已入库', stale:'已归档' }
  return Object.entries(names).filter(([k])=>s[k] != null).map(([k,name])=>({ name, value:values[text(s[k])] ?? text(s[k]) }))
})
const readme = computed(() => {
  const r = selectedVersion.value?.readme ?? entity.value?.readme
  return record(r) ? r : null
})
const versionOptions = computed(() => versions.value.map((v,i)=>({label:`历史版本 ${text(v.version ?? v.versionNumber, String(versions.value.length-i))} · ${date(v.observedAt ?? v.createdAt)}`,value:i})))
const versionIndex = computed({ get:()=>Math.max(0,versions.value.indexOf(selectedVersion.value ?? {})), set:(i:number)=>{ selectedVersion.value = versions.value[i] ?? null } })
watch(currentRunId, () => { selectedSnapshotEntry.value = null })
watch(section, () => { collapsed.value = false; void load() }, { immediate:true })
watch([currentRunId,currentEntityId], () => void loadDetails(), {immediate:true})
onBeforeUnmount(()=>{ disposed=true; generation++; detailGeneration++; stopPoll(); document.removeEventListener('visibilitychange',visibility) })
</script>

<template>
<div class="shell">
  <aside :class="['sidebar', {expanded:collapsed}]">
    <div class="brand">PAGE GATHER<span>采集工作台</span></div>
    <nav aria-label="主导航"><router-link v-for="item in nav" :key="item.key" :to="`/${item.key}`" :class="{selected:section===item.key}">{{ item.title }}</router-link></nav>
    <div class="sidebar-foot">GitHub Trending<br><span>手动 / 每日计划 · 结果留存</span></div>
  </aside>
  <div class="workspace">
    <header class="topbar"><n-button class="menu-toggle" @click="collapsed=!collapsed" :aria-expanded="collapsed" aria-label="展开或收起导航">☰</n-button><span>数据采集 / {{ titles[section] }}</span><n-button quaternary @click="logout">退出登录</n-button></header>
    <main class="content">
      <div class="page-heading"><div><h1>{{ titles[section] }}</h1><p class="muted">采集 GitHub 每日趋势，自选手动执行或每日计划。</p></div><n-button :loading="loading" @click="refresh">刷新</n-button></div>
      <n-alert v-if="error" type="error" class="gap" role="alert">{{ error }}<div><n-button @click="load">重试</n-button></div></n-alert>
      <n-alert v-if="manual" type="warning" class="gap" title="浏览器处于人工模式">任务会等待人工操作结束后开始采集。<a v-if="previewUrl" :href="previewUrl" target="_blank" rel="noopener noreferrer">打开浏览器预览 ↗</a></n-alert>
      <template v-if="section==='overview'">
        <div class="stats"><n-card title="服务状态"><strong>{{ healthy ? '服务可用' : '服务异常或未连接' }}</strong><p class="muted">同源安全会话</p></n-card><n-card title="已加载任务"><strong>{{ tasks.length }}</strong><p class="muted">每日计划需明确开启</p></n-card><n-card title="浏览器状态"><strong>{{ workers.length ? label(workers[0]?.mode) : '暂无心跳' }}</strong><p class="muted">{{ workers.some(w=>w.busy) ? '正在执行任务' : '当前无忙碌任务' }}</p></n-card></div>
        <n-card title="每日调度状态" class="gap">
          <n-alert v-if="schedulerError" type="error" role="alert">调度状态不可用，不能确认健康：{{ schedulerError }}<div><n-button @click="loadScheduler()">重试调度状态</n-button></div></n-alert>
          <template v-else-if="scheduler"><n-tag :type="scheduler.healthy && !scheduler.lastErrorCode ? 'success' : 'error'">{{ scheduler.healthy && !scheduler.lastErrorCode ? '调度健康' : '调度异常' }}</n-tag><p>{{ scheduler.enabled ? '调度已开启' : '调度已关闭' }} · 上次 tick：{{ scheduleDate(scheduler.lastTickAt) }}</p><p>下次唤醒：{{ scheduleDate(scheduler.nextWakeAt) }}</p><p class="muted">已创建 {{ text(scheduler.stats.created,'0') }} · 已跳过 {{ text(scheduler.stats.skipped,'0') }} · 时间以 UTC 展示</p><p v-if="scheduler.lastErrorCode">{{ scheduleReason(scheduler.lastErrorCode) }}</p></template>
          <p v-else class="muted">正在读取调度状态…</p><p class="muted">进入概览或点击刷新时更新，不在后台持续轮询。</p>
        </n-card>
        <n-card title="开始一次采集" class="gap"><p>选择预置任务，调整采集数量与间隔，然后手动执行。结果会保存在运行记录与项目资料库中。</p><n-space><n-button type="primary" @click="router.push('/tasks')">查看任务</n-button><n-button v-if="previewUrl" tag="a" :href="previewUrl" target="_blank" rel="noopener noreferrer">浏览器预览 ↗</n-button></n-space></n-card>
        <n-card title="最近完成的结果" class="gap"><template v-if="latestCompleted"><n-space align="center"><n-tag>{{ label(latestCompleted.status) }}</n-tag><span>{{ date(latestCompleted.finishedAt ?? latestCompleted.createdAt) }}</span><n-button type="primary" secondary @click="openRun(latestCompleted.id)">查看榜单与 README</n-button></n-space></template><n-empty v-else description="当前已加载记录中暂无完成结果"><template #extra><n-button @click="router.push('/runs')">查看所有运行</n-button></template></n-empty></n-card>
        <n-card title="Worker 状态"><n-empty v-if="!workers.length" description="尚未收到 Worker 心跳"/><div v-for="(w,i) in workers" :key="text(w.id ?? w.workerId,String(i))" class="worker-row"><div><b>{{ text(w.workerId ?? w.id,'采集浏览器') }}</b><p class="muted">最近心跳：{{ date(w.lastHeartbeatAt ?? w.lastSeenAt) }}</p></div><n-tag>{{ label(w.mode) }} · {{ w.busy ? '忙碌' : '空闲' }}</n-tag><n-button v-if="typeof w.activeRunId==='string'" @click="openRun(w.activeRunId)">查看当前运行</n-button></div></n-card>
      </template>
      <template v-if="section==='tasks'">
        <n-alert type="info" class="gap">任务由服务端预置，旧任务的每日计划默认关闭。只有任务和每日计划均启用才会自动运行；手动采集不会开启每日计划。GitHub daily 是滚动趋势窗口。</n-alert>
        <n-empty v-if="!loading && !tasks.length" description="暂无任务，请检查服务端预置任务是否就绪" />
        <n-card v-for="t in tasks" :key="t.id" :title="t.name" class="gap"><template #header-extra><n-tag :type="t.enabled?'success':'default'">{{ t.enabled?'已启用':'已停用' }}</n-tag></template><div class="task-meta"><span>采集数量 <b>{{ text(t.config.maxRepos,'25') }}</b></span><span>间隔 <b>{{ text(t.config.itemDelayMs,'5000') }} ms</b></span><span>语言 <b>{{ text(t.config.language,'全部') }}</b></span></div><div class="schedule-meta"><n-tag :type="t.schedule.enabled && t.enabled ? 'info' : 'default'">{{ t.schedule.enabled ? (t.enabled ? '每日计划' : '每日计划开启 · 任务停用') : '仅手动' }}</n-tag><p>当地时间 {{ t.schedule.time }} · 时区 {{ t.schedule.timezone }}</p><p>下一次：{{ scheduleDate(t.nextScheduledAt, t.schedule.timezone) }}</p><p class="muted">上次计划：{{ scheduleDate(t.lastScheduledFor, t.schedule.timezone) }}</p><p class="muted">调度处理：{{ scheduleStatusText(t.scheduleStatus, t.schedule.timezone) }}</p></div><n-space><n-button type="primary" :disabled="!t.enabled || starting!==null" :loading="starting===t.id" @click="start(t)">{{ retryKeys.has(t.id)?'重试启动':'手动采集' }}</n-button><n-button @click="edit(t)">编辑参数</n-button></n-space></n-card>
        <n-button v-if="taskCursor" :loading="loading" @click="more('tasks')">加载更多任务</n-button>
      </template>
      <template v-if="section==='runs'">
        <n-card v-if="currentRunId" title="运行详情" class="gap"><template #header-extra><n-button @click="router.push('/runs')">返回列表</n-button></template>
          <n-alert v-if="detailError" type="error" role="alert">{{ detailError }}<div><n-button @click="loadDetails">重试</n-button></div></n-alert>
          <template v-if="selectedRun"><div class="run-heading"><div><span class="eyebrow">RUN ID</span><p class="mono">{{ selectedRun.id }}</p></div><n-tag>{{ label(selectedRun.status) }}</n-tag><n-button v-if="active(selectedRun)" type="error" secondary :loading="cancelling" :disabled="Boolean(selectedRun.cancelRequested)" @click="cancelRun">{{ selectedRun.cancelRequested?'正在取消':'取消采集' }}</n-button></div>
            <n-progress v-if="progress!==undefined" type="line" :percentage="progress" :processing="active(selectedRun)" />
            <p class="muted">阶段：{{ label(selectedRun.stage ?? selectedRun.progress?.phase) }} · 进度 {{ text(selectedRun.progress?.completed,'0') }} / {{ text(selectedRun.progress?.total,'待确认') }}<span v-if="selectedRun.progress?.itemKey"> · {{ text(selectedRun.progress.itemKey) }}</span></p>
            <p>触发方式：{{ label(selectedRun.trigger ?? 'manual') }} · {{ runScheduleText(selectedRun) }}</p>
            <p v-if="selectedRun.status==='SKIPPED'" class="muted">本次已跳过（终态），不会继续轮询，也不计为成功结果。</p>
            <p class="muted">创建 {{ date(selectedRun.createdAt) }} · 结束 {{ date(selectedRun.finishedAt) }}</p>
            <n-alert v-if="pollError" type="error" class="gap" role="alert">进度刷新已停止：{{ pollError }}<div><n-button @click="retryPoll">重试刷新</n-button></div></n-alert>
            <n-alert v-if="selectedRun.error" type="warning" class="gap">本次运行未完整结束：{{ scheduleReason(selectedRun.error) }}</n-alert>
            <div v-if="summary.length" class="summary"><span v-for="s in summary" :key="s.name">{{ s.name }}：{{ s.value }}　</span></div>
            <div class="section-heading"><h2>榜单快照 <span class="muted">{{ entries.length }} 项</span></h2><span class="muted">{{ date(selectedRun.snapshot?.observedAt) }}</span></div>
            <p class="muted">点击项目查看 README。待采集与失败项目会保留在完整榜单中。</p>
            <n-empty v-if="!entries.length" :description="selectedRun.status==='SKIPPED' ? '本次计划已跳过，没有采集榜单或 README' : active(selectedRun)?'正在等待榜单快照，进度每 3 秒更新':'本次运行暂无榜单快照'" />
            <div v-else><div class="desktop-table"><n-data-table :columns="entryColumns" :data="entries" :row-key="(e:Entry)=>e.key" :bordered="false" /></div><div class="mobile-cards"><n-card v-for="e in entries" :key="e.key" size="small"><div class="card-heading"><b>#{{ e.rank }}</b><n-tag>{{ label(e.status) }}</n-tag></div><n-button text type="primary" @click="viewEntry(e)">{{ e.key }}</n-button><p>{{ text(e.description,'暂无描述') }}</p><p class="muted">{{ text(e.language) }} · ★ {{ text(e.stars) }} · {{ text(e.dailyChange) }}</p><p v-if="e.status==='failed'" class="muted">本项目采集失败</p></n-card></div></div>
          </template><p v-else-if="!detailError" class="muted" role="status">正在加载运行详情…</p>
        </n-card>
        <n-card title="运行历史"><div class="desktop-table"><n-data-table :columns="runColumns" :data="runs" :bordered="false" /></div><div class="mobile-cards"><n-card v-for="r in runs" :key="r.id" size="small"><n-tag>{{ label(r.status) }}</n-tag><p class="mono">{{ r.id }}</p><p>{{ label(r.trigger ?? 'manual') }}</p><p class="muted">{{ runScheduleText(r) }}</p><p class="muted">{{ date(r.createdAt) }}</p><n-button block @click="openRun(r.id)">查看运行</n-button></n-card><n-empty v-if="!runs.length" description="暂无运行记录" /></div><n-button v-if="runCursor" :loading="loading" class="gap-top" @click="more('runs')">加载更多运行</n-button></n-card>
      </template>
      <template v-if="section==='entities'">
        <n-card class="gap"><n-form class="search-form" @submit.prevent="searchEntities(false)"><n-form-item label="项目关键词"><n-input v-model:value="query" clearable placeholder="搜索项目名称" /></n-form-item><n-form-item label="实体类型（可选）"><n-input v-model:value="entityType" clearable placeholder="全部类型" /></n-form-item><n-button type="primary" attr-type="submit" :loading="loading">搜索</n-button></n-form></n-card>
        <n-card title="已入库项目"><div class="desktop-table"><n-data-table :columns="entityColumns" :data="entities" :bordered="false" /></div><div class="mobile-cards"><n-card v-for="e in entities" :key="e.id" size="small"><b>{{ text(e.sourceKey,text(e.name,e.id)) }}</b><p class="muted">{{ text(e.entityType) }} · {{ date(e.lastSeenAt) }}</p><n-button block @click="openEntity(e.id)">查看 README 与历史</n-button></n-card><n-empty v-if="!entities.length" description="暂无匹配的项目" /></div><n-button v-if="entityCursor" :loading="loading" class="gap-top" @click="searchEntities(true)">加载更多项目</n-button></n-card>
      </template>
    </main>
  </div>
  <n-drawer :show="!!editTask" :width="520" :close-on-esc="!saving" :mask-closable="!saving" @update:show="v=>{if(!v&&!saving)editTask=null}"><n-drawer-content title="任务参数" closable><n-form @submit.prevent="saveTask"><n-form-item label="任务名称"><n-input v-model:value="form.name" maxlength="120" /></n-form-item><n-form-item label="采集项目数（1–100）"><n-input-number :value="form.maxRepos" @update:value="v=>form.maxRepos=v??25" :min="1" :max="100" :precision="0" :show-button="true" /></n-form-item><n-form-item label="项目间隔（毫秒，至少 3000）"><n-input-number :value="form.itemDelayMs" @update:value="v=>form.itemDelayMs=v??5000" :min="3000" :max="3600000" :step="1000" :precision="0" /></n-form-item><n-form-item label="编程语言（可选）"><n-select v-model:value="form.language" filterable tag :options="[{label:'全部语言',value:''},{label:'TypeScript',value:'typescript'},{label:'JavaScript',value:'javascript'},{label:'Python',value:'python'},{label:'Go',value:'go'},{label:'Rust',value:'rust'},{label:'Java',value:'java'},{label:'C++',value:'c++'}]" /></n-form-item><n-form-item label="自然语言（可选，如 zh、en）"><n-input v-model:value="form.spokenLanguage" placeholder="留空表示全部" /></n-form-item><n-form-item label="启用任务"><n-switch v-model:value="form.enabled" /></n-form-item><n-form-item label="启用每日计划（默认关闭）"><n-switch v-model:value="form.schedule.enabled" /></n-form-item><n-form-item label="每日当地时间（HH:mm）"><n-input v-model:value="form.schedule.time" placeholder="09:00" maxlength="5" /></n-form-item><n-form-item label="IANA 时区（可输入其他时区）"><n-select v-model:value="form.schedule.timezone" filterable tag :options="timezoneOptions" /></n-form-item><n-alert v-if="scheduleValidation" type="error" class="gap">{{ scheduleValidation }}</n-alert><n-alert :type="form.schedule.enabled && !form.enabled ? 'warning' : 'info'" class="gap">{{ scheduleSaveHint }}</n-alert><p class="muted">服务恢复时仅补最近 24 小时内最新的一次；同一任务正在排队、运行或恢复时，本次计划时段跳过。浏览器人工模式下排队等待，不抢占人工操作。修改时间、时区或启停后从未来安排，正在运行的任务不自动取消。</p><p class="muted">时间为所选时区的当地时间，不是浏览器时区。夏令时重复分钟取较早一次，不存在的分钟顺延至当天首个有效时刻。时区最终由服务端 Intl 校验。</p><n-button attr-type="submit" type="primary" :loading="saving" :disabled="!!scheduleValidation" block>保存参数与每日计划</n-button></n-form><details class="gap-top"><summary>当前任务 config</summary><pre class="json-text">{{ JSON.stringify(editTask?.config,null,2) }}</pre></details></n-drawer-content></n-drawer>
  <run-snapshot-drawer :run="selectedRun" :entry="selectedSnapshotEntry" @close="selectedSnapshotEntry=null" @open-entity="viewSnapshotEntity" />
  <n-drawer :show="!!currentEntityId" :width="820" @update:show="v=>{if(!v)closeEntity()}"><n-drawer-content title="实体资料 · README 与版本历史" closable>
    <n-alert v-if="detailError" type="error" role="alert">{{ detailError }}<div><n-button @click="loadDetails">重试</n-button></div></n-alert>
    <template v-if="entity"><h2>{{ text(entity.sourceKey,text(entity.name,text(entity.id))) }}</h2><p class="muted">更新于 {{ date(entity.lastSeenAt) }}</p><a v-if="safeUrl(entity.sourceUrl)" :href="safeUrl(entity.sourceUrl)" target="_blank" rel="noopener noreferrer">在来源网站打开 ↗</a><n-form-item label="版本历史" class="gap-top"><n-select v-if="versions.length" v-model:value="versionIndex" :options="versionOptions" /><span v-else class="muted">暂无历史版本</span></n-form-item><n-alert v-if="readme?.status==='not_found'" type="info">来源页面没有 README。</n-alert><template v-else-if="readme && typeof readme.text==='string'"><div class="readme-meta"><n-tag>README · 页面文本</n-tag><a v-if="safeUrl(readme.sourceUrl)" :href="safeUrl(readme.sourceUrl)" target="_blank" rel="noopener noreferrer">README 来源 ↗</a></div><p class="muted">{{ readme.truncated===true?'来源正文已截断。':readme.truncated===null?'来源页面是否截断未知。':'所选版本的 README 正文。' }}</p><pre class="readme" v-text="readme.text" /></template><n-empty v-else description="当前版本暂无可读取的 README 正文" /></template><p v-else-if="!detailError" role="status">正在加载项目资料…</p>
  </n-drawer-content></n-drawer>
</div>
</template>
