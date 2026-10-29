<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NAlert, NButton, NCard, NEmpty, NSpace, NSwitch, NTag } from 'naive-ui'
import { date } from './api'
import { notificationsClient, notificationQueryId, originalTarget, validId } from './notifications'
import type { NotificationDetail, NotificationItem } from './notifications'
import { notificationsChanged } from './useUnread'
import NotificationLayout from './NotificationLayout.vue'
const route = useRoute(), router = useRouter()
const items = ref<NotificationItem[]>([]), cursor = ref<string|null>(null), unread = ref(false), loading = ref(false), error = ref(''), detailError = ref(''), detail = ref<NotificationDetail|null>(null), detailLoading = ref(false), reading = ref(false), markingAll = ref(false)
const selection = computed(()=>{ try { return {id:notificationQueryId(route.query),error:''} } catch(e) { return {id:'',error:report(e)} } })
const id = computed(() => selection.value.id)
const target = computed(() => detail.value ? originalTarget(detail.value) : undefined)
let listGeneration = 0, detailGeneration = 0, disposed = false
function report(e:unknown) { return e instanceof Error ? e.message : '操作失败，请重试。' }
async function load(more = false) {
  const request = ++listGeneration
  loading.value = true; error.value = ''
  if (!more) { items.value = []; cursor.value = null }
  const params = new URLSearchParams({limit:'50'})
  if (unread.value) params.set('unread','true')
  if (more && cursor.value) params.set('cursor',cursor.value)
  try {
    const result = await notificationsClient.list(params)
    if (disposed || request !== listGeneration) return
    if (more && result.nextCursor && result.nextCursor === cursor.value) throw new Error('通知分页游标重复，请刷新重试。')
    items.value = more ? [...items.value,...result.items] : result.items; cursor.value = result.nextCursor
  } catch(e) { if (!disposed && request === listGeneration) error.value = report(e) } finally { if (!disposed && request === listGeneration) loading.value = false }
}
async function markRead() {
  const value = detail.value, request = detailGeneration
  if (!value || value.readAt || reading.value || document.hidden || id.value !== value.id) return
  reading.value = true
  try {
    const result = await notificationsClient.read(value.id)
    if (disposed) return
    if (request === detailGeneration && id.value === value.id) { detail.value = result; detailError.value = '' }
    // 写入事实不因用户关闭/切换详情而失效；只守卫详情赋值，列表和角标仍须同步。
    notificationsChanged()
    await load()
  } catch(e) { if (!disposed && request === detailGeneration) detailError.value = `详情已加载，但标记已读失败：${report(e)}` } finally { if (!disposed && request === detailGeneration) reading.value = false }
}
async function openDetail() {
  const request = ++detailGeneration, selected = id.value
  detail.value = null; detailError.value = ''; reading.value = false; detailLoading.value = !!selected
  if (selection.value.error) { detailError.value = selection.value.error; detailLoading.value = false; return }
  if (!selected) return
  if (!validId(selected)) { detailError.value = '通知标识无效。'; detailLoading.value = false; return }
  try {
    const value = await notificationsClient.detail(selected)
    if (value.id !== selected) throw new Error('通知详情标识不匹配，未标记已读。')
    if (disposed || request !== detailGeneration) return
    detail.value = value
    await nextTick()
    // 只有成功渲染且前台可见的详情才回传已读，SW 点击本身不修改状态。
    if (!disposed && request === detailGeneration) await markRead()
  } catch(e) { if (!disposed && request === detailGeneration) detailError.value = report(e) } finally { if (!disposed && request === detailGeneration) detailLoading.value = false }
}
async function readAll() {
  if (markingAll.value || !window.confirm('将所有站内通知标记为已读？此操作不表示推送已送达。')) return
  markingAll.value = true; error.value = ''
  try { await notificationsClient.readAll(); await load(); notificationsChanged(); if (id.value) await openDetail() } catch(e) { error.value = report(e) } finally { markingAll.value = false }
}
watch(unread,()=>void load())
watch(()=>[route.query.id,route.query.notificationId],()=>void openDetail(),{immediate:true})
void load()
function visibleDetail() { if (!document.hidden && detail.value && !detail.value.readAt) void markRead() }
document.addEventListener('visibilitychange',visibleDetail)
onBeforeUnmount(()=>{ disposed = true; listGeneration++; detailGeneration++; items.value = []; detail.value = null; document.removeEventListener('visibilitychange',visibleDetail) })
</script>
<template><notification-layout title="通知中心"><n-space class="gap" align="center"><label class="switch-label"><n-switch v-model:value="unread" aria-label="只看未读通知" />只看未读</label><n-button :loading="loading" @click="load()">刷新列表</n-button><n-button :loading="markingAll" @click="readAll">全部标为已读</n-button><n-button @click="router.push('/notification-settings')">规则与设备</n-button></n-space><n-alert v-if="error" class="gap" type="error" role="alert">{{ error }}</n-alert><n-card v-if="route.query.id!==undefined || route.query.notificationId!==undefined" title="通知详情" class="gap"><template #header-extra><n-button @click="router.push('/notifications')">关闭详情</n-button></template><n-alert v-if="detailError" type="error" role="alert" class="gap">{{ detailError }}<div><n-button v-if="detail && !detail.readAt" :loading="reading" @click="markRead">重试标记已读</n-button><n-button v-else @click="openDetail">重试详情</n-button></div></n-alert><p v-if="detailLoading" role="status">正在加载通知…</p><template v-if="detail"><h2>{{ detail.title }}</h2><p class="muted">{{ date(detail.createdAt) }} · {{ detail.kind==='test' ? '测试通知' : '业务通知' }} · {{ detail.readAt ? '已读' : '未读' }}</p><pre class="readme" v-text="detail.body" /><p class="muted">设备投递：待处理 {{ detail.delivery.pending }} · 重试 {{ detail.delivery.retry }} · 服务 accepted {{ detail.delivery.accepted }} · 失败 {{ detail.delivery.failed }} · 已跳过 {{ detail.delivery.skipped }}。服务接受不代表手机展示或用户已读。</p><router-link v-if="target" :to="target" class="touch-link">查看原运行 / 历史版本 →</router-link><p v-else class="muted">这条通知没有可用的原始记录目标。</p></template></n-card><n-empty v-if="!loading && !error && !items.length" description="暂无符合条件的通知" /><n-card v-for="item in items" :key="item.id" class="gap"><div class="card-heading"><n-tag :type="item.readAt ? 'default' : 'info'">{{ item.readAt ? '已读' : '未读' }}</n-tag><span class="muted">{{ date(item.createdAt) }}</span></div><router-link :to="{path:'/notifications',query:{id:item.id}}" class="touch-link notification-title">{{ item.title }}</router-link><p v-if="item.kind==='test'" class="muted">显式推送测试（不代表手机已展示）</p></n-card><n-button v-if="cursor" :loading="loading" @click="load(true)">加载更多通知</n-button></notification-layout></template>
