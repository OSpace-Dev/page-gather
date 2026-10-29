<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { NAlert, NButton, NCard, NForm, NFormItem, NInput, NSelect, NSpace, NSwitch, NTag } from 'naive-ui'
import { api, date, page, row, task } from './api'
import type { Page, Task } from './api'
import { notificationsClient, parseDevice, parsePushConfig, parsePushStatus, parseRule, ruleError } from './notifications'
import type { Device, NotificationRule, PushConfig, PushStatus, RuleInput } from './notifications'
import { localDeviceId, pushUnavailable, removeLocalDevice, subscribeFromClick, testCurrentDevice } from './push'
import { notificationsChanged } from './useUnread'
import { checkUpdateFromClick, installAvailable, installed, installFromClick, updateStatus } from './pwa'
import NotificationLayout from './NotificationLayout.vue'
const rules = ref<NotificationRule[]>([]), devices = ref<Device[]>([]), config = ref<PushConfig|null>(null), status = ref<PushStatus|null>(null), taskOptions = ref<{label:string;value:string}[]>([])
const error = ref(''), pushError = ref(''), info = ref(''), loading = ref(false), saving = ref(false), busy = ref(false), editing = ref<string|null>(null), showForm = ref(false), deviceLabel = ref('本机浏览器'), deviceId = ref(localDeviceId()), unsupported = ref(pushUnavailable())
const rulesCursor = ref<string|null>(null), devicesCursor = ref<string|null>(null)
const defaults = (): RuleInput => ({ name:'', enabled:true, taskIds:[], eventTypes:['baseline','created','changed'], keywords:[], pushEnabled:false })
const form = ref(defaults()), keywordsText = ref('')
const eventOptions = [{label:'首次完整基线',value:'baseline'},{label:'新增项目',value:'created'},{label:'内容变化',value:'changed'}]
const input = computed<RuleInput>(() => ({name:form.value.name.trim(),enabled:form.value.enabled,taskIds:[...form.value.taskIds],eventTypes:[...form.value.eventTypes],keywords:keywordsText.value.split('\n').map(x=>x.trim()).filter(Boolean),pushEnabled:form.value.pushEnabled}))
const validation = computed(()=>ruleError(input.value))
const canSubscribe = computed(()=>!unsupported.value && !!config.value?.configured && !!config.value?.enabled)
const currentDevice = computed(()=>devices.value.find(d=>d.id===deviceId.value))
const owned = computed(()=>!!currentDevice.value?.owned && !loading.value)
let disposed = false, generation = 0, testKey: string | undefined, testDevice: string | undefined
function report(e:unknown) { return e instanceof Error ? e.message : '操作失败，请重试。' }
async function load() {
  const request = ++generation
  loading.value = true; error.value = ''; pushError.value = ''; config.value = null; status.value = null; devices.value = []; devicesCursor.value = null
  const results = await Promise.allSettled([
    notificationsClient.rules().then(p=>{if (!disposed && request===generation) {rules.value=p.items;rulesCursor.value=p.nextCursor}}),
    (async()=>{ const options: {label:string;value:string}[] = []; let cursor:string|null=null; const seen=new Set<string>(); do { const p: Page<Task>=page(await api(`/tasks?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),task); options.push(...p.items.map(t=>({label:t.name,value:t.id}))); if(p.nextCursor && seen.has(p.nextCursor)) throw new Error('任务分页游标重复。'); cursor=p.nextCursor; if(cursor) seen.add(cursor) } while(cursor && !disposed && request===generation); if(!disposed && request===generation) taskOptions.value=options })(),
    (async()=>{ const [c,s,d] = await Promise.all([api('/push/config').then(parsePushConfig),api('/push/status').then(parsePushStatus),notificationsClient.devices()]); if (!disposed && request===generation) {config.value=c;status.value=s;devices.value=d.items;devicesCursor.value=d.nextCursor} })().catch(e=>{if(!disposed && request===generation) pushError.value=report(e)})
  ])
  if (disposed || request!==generation) return
  const failure = results.find((r):r is PromiseRejectedResult=>r.status==='rejected')
  if(failure) error.value=report(failure.reason)
  loading.value=false; unsupported.value=pushUnavailable(); deviceId.value=localDeviceId()
}
async function moreRules() { if(!rulesCursor.value || loading.value) return; loading.value=true; try { const p=page(await api(`/notification-rules?limit=200&cursor=${encodeURIComponent(rulesCursor.value)}`),parseRule); if(p.nextCursor===rulesCursor.value) throw new Error('规则分页游标重复。'); rules.value.push(...p.items);rulesCursor.value=p.nextCursor } catch(e){error.value=report(e)} finally{loading.value=false} }
async function moreDevices() { if(!devicesCursor.value || loading.value) return; loading.value=true; try { const p=page(await api(`/push/subscriptions?limit=200&cursor=${encodeURIComponent(devicesCursor.value)}`),parseDevice); if(p.nextCursor===devicesCursor.value) throw new Error('设备分页游标重复。'); devices.value.push(...p.items);devicesCursor.value=p.nextCursor } catch(e){pushError.value=report(e)} finally{loading.value=false} }
function edit(rule?:NotificationRule) { editing.value=rule?.id??null; form.value=rule ? {...rule,taskIds:[...rule.taskIds],eventTypes:[...rule.eventTypes],keywords:[...rule.keywords]} : defaults(); keywordsText.value=form.value.keywords.join('\n'); showForm.value=true; error.value='' }
async function save() {
  if(saving.value || validation.value) return
  saving.value=true;error.value=''
  try { const value=await api(editing.value ? `/notification-rules/${encodeURIComponent(editing.value)}` : '/notification-rules',editing.value?'PATCH':'POST',input.value); parseRule(row(value).rule); showForm.value=false; info.value='规则已保存，仅影响之后产生的事件，不补发历史通知。'; await load() } catch(e){error.value=report(e)} finally{saving.value=false}
}
async function remove(rule:NotificationRule) {
  if(saving.value || !window.confirm(`删除规则“${rule.name}”？仅影响之后的事件。`)) return
  saving.value=true
  try { await api(`/notification-rules/${encodeURIComponent(rule.id)}`,'DELETE'); await load() } catch(e){error.value=report(e)} finally{saving.value=false}
}
async function subscribe() {
  if(busy.value || !config.value) return
  busy.value=true;pushError.value='';info.value=''
  try { const device=await subscribeFromClick(config.value,deviceLabel.value); deviceId.value=device.id; info.value='本机订阅已登记；这不证明手机锁屏通知已展示。'; await load() } catch(e){pushError.value=report(e)} finally{unsupported.value=pushUnavailable();busy.value=false}
}
async function unsubscribe() {
  if(busy.value) return
  busy.value=true;pushError.value='';info.value=''
  try { const warnings=await removeLocalDevice(); deviceId.value=null; info.value=warnings.length ? warnings.join(' ') : '本机浏览器与服务器设备订阅已解除；其他设备不受影响。'; await load() } catch(e){pushError.value=report(e)} finally{busy.value=false}
}
async function testPush() {
  if(busy.value) return
  if(!deviceId.value || !owned.value || !currentDevice.value?.enabled) { pushError.value='请先主动订阅或重新登记本机以绑定当前登录会话，再发送仅针对本机的推送测试。'; return }
  busy.value=true;pushError.value='';info.value=''
  try {
    const subscriptionId = deviceId.value
    if (testDevice !== subscriptionId) { testKey = undefined; testDevice = subscriptionId }
    testKey ??= crypto.randomUUID()
    await testCurrentDevice(testKey)
    testKey=undefined; info.value='测试请求已 accepted（受理）。不代表推送服务或手机已接收、展示或已读，请在站内通知与投递状态中查看后续结果。'; notificationsChanged(); await load()
  } catch(e){pushError.value=report(e)} finally{busy.value=false}
}
void load()
onBeforeUnmount(()=>{disposed=true;generation++;rules.value=[];devices.value=[];config.value=null;status.value=null})
</script>
<template><notification-layout title="通知规则与设备设置"><n-space class="gap"><n-button :loading="loading" @click="load">刷新设置</n-button><n-button type="primary" :disabled="saving" @click="edit()">新增规则</n-button></n-space><n-alert v-if="error" type="error" role="alert" class="gap">{{ error }}</n-alert><n-alert v-if="info" type="info" role="status" class="gap">{{ info }}</n-alert><n-card v-if="showForm" :title="editing ? '编辑规则' : '新增规则'" class="gap"><n-form @submit.prevent="save"><n-form-item label="名称" :label-props="{for:'notification-rule-name'}"><n-input v-model:value="form.name" :input-props="{id:'notification-rule-name',name:'ruleName'}" maxlength="200" /></n-form-item><n-form-item label="启用规则" :label-props="{id:'notification-rule-enabled-label'}"><n-switch v-model:value="form.enabled" aria-labelledby="notification-rule-enabled-label" /></n-form-item><n-form-item label="任务（留空表示全部）" :label-props="{id:'notification-rule-tasks-label',for:'notification-rule-tasks'}"><n-select v-model:value="form.taskIds" aria-labelledby="notification-rule-tasks-label" :input-props="{id:'notification-rule-tasks',name:'ruleTaskIds','aria-labelledby':'notification-rule-tasks-label'}" multiple filterable :options="taskOptions" /></n-form-item><n-form-item label="事件类型" :label-props="{id:'notification-rule-events-label',for:'notification-rule-events'}"><n-select v-model:value="form.eventTypes" aria-labelledby="notification-rule-events-label" :input-props="{id:'notification-rule-events',name:'ruleEventTypes','aria-labelledby':'notification-rule-events-label'}" multiple filterable :options="eventOptions" /></n-form-item><n-form-item label="关键词（每行一个，留空表示不限制）" :label-props="{for:'notification-rule-keywords'}"><n-input v-model:value="keywordsText" :input-props="{id:'notification-rule-keywords',name:'ruleKeywords'}" type="textarea" :autosize="{minRows:3,maxRows:8}" /></n-form-item><n-form-item label="允许本规则发送设备推送（默认关闭）" :label-props="{id:'notification-rule-push-label'}"><n-switch v-model:value="form.pushEnabled" aria-labelledby="notification-rule-push-label" /></n-form-item><n-alert v-if="validation" type="warning" class="gap">{{ validation }}</n-alert><p class="muted">规则修改仅影响之后的事件；停用或关闭推送也会阻止尚未发送的投递。站内通知无需 VAPID、安装或系统授权。</p><n-space><n-button type="primary" attr-type="submit" :disabled="!!validation" :loading="saving">保存规则</n-button><n-button :disabled="saving" @click="showForm=false">取消</n-button></n-space></n-form></n-card><n-card v-for="rule in rules" :key="rule.id" :title="rule.name" class="gap"><n-space><n-tag>{{ rule.enabled ? '启用' : '停用' }}</n-tag><n-tag>{{ rule.pushEnabled ? '允许设备推送' : '仅站内' }}</n-tag></n-space><p>任务：{{ rule.taskIds.length ? rule.taskIds.map(id=>taskOptions.find(t=>t.value===id)?.label??id).join('、') : '全部任务' }}</p><p>事件：{{ rule.eventTypes.map(x=>eventOptions.find(o=>o.value===x)?.label).join('、') }}</p><p>关键词：{{ rule.keywords.join('、') || '不限' }}</p><n-space><n-button :disabled="saving" @click="edit(rule)">编辑 / 停用</n-button><n-button type="error" secondary :disabled="saving" @click="remove(rule)">删除</n-button></n-space></n-card><n-button v-if="rulesCursor" class="gap" :loading="loading" @click="moreRules">更多规则</n-button><n-card title="本机推送与安装" class="gap"><n-alert v-if="pushError" type="error" role="alert" class="gap">{{ pushError }}</n-alert><n-alert v-if="unsupported" type="warning" class="gap">{{ unsupported }}</n-alert><p v-if="config">服务器：{{ config.configured ? '已配置' : '未配置 VAPID' }} / {{ config.enabled ? '推送已启用' : '推送关闭' }}<span v-if="config.reason"> · {{ config.reason }}</span></p><p v-else class="muted">无法确认服务器推送配置，请刷新重试。站内通知仍独立可用。</p><p>iOS/iPadOS 16.4 起需在 Safari 中“分享 → 添加到主屏幕”，再从主屏幕图标打开并点击订阅。请勿把模拟测试当作 iPhone 真机通过。</p><p class="muted">安装状态：{{ installed ? '正在独立窗口中使用' : '浏览器窗口（可使用菜单安装）' }}。离线只显示公开提示，不保存个人通知或 README。</p><n-form-item label="本机设备名称" :label-props="{for:'notification-device-label'}"><n-input v-model:value="deviceLabel" :input-props="{id:'notification-device-label',name:'deviceLabel'}" maxlength="80" /></n-form-item><n-space><n-button type="primary" :disabled="!canSubscribe || busy" :loading="busy" @click="subscribe">{{ deviceId ? '重新登记本机订阅' : '主动授权并订阅本机' }}</n-button><n-button :disabled="busy || !owned" @click="unsubscribe">解除本机订阅</n-button><n-button :disabled="!config?.configured || !config?.enabled || !owned || !currentDevice?.enabled || busy" @click="testPush">{{ testKey ? '安全重试推送测试' : '发送明确的推送测试' }}</n-button><n-button v-if="installAvailable && !installed" @click="installFromClick">安装应用</n-button><n-button @click="checkUpdateFromClick">检查应用更新</n-button></n-space><p v-if="deviceId && !owned" class="muted">本地设备标识不代表当前 session 归属。会话到期重新登录后，请点击“重新登记本机订阅”；会提交浏览器现有订阅的相同 keys 续绑，不自动重新授权或发送测试。确认 owned 前不能删除或测试。</p><p v-if="updateStatus" role="status" class="muted">{{ updateStatus }}</p><p class="muted">权限仅在主动点击订阅时请求；拒绝后请在系统设置调整。只持久保存本机 device id，不存 token、endpoint 或订阅密钥。请先订阅本机才能测试，测试只针对本机，不广播其他设备；受理不代表手机送达。</p></n-card><n-card title="设备列表（安全元数据）" class="gap"><p v-if="!devices.length" class="muted">暂无已加载设备。</p><div v-for="device in devices" :key="device.id" class="device-row"><b>{{ device.deviceLabel }}</b><n-tag>{{ device.id===deviceId ? '本机' : '其他设备' }}</n-tag><n-tag>{{ device.enabled ? '启用' : '停用' }}</n-tag><n-tag>{{ device.owned ? '属于当前登录会话' : '不属于当前登录会话' }}</n-tag><p class="muted">登记 {{ date(device.createdAt) }} · 更新 {{ date(device.updatedAt) }}</p></div><n-button v-if="devicesCursor" :loading="loading" @click="moreDevices">更多设备</n-button><p class="muted">解除订阅与退出登录只影响本机，不会注销其他设备。</p></n-card><n-card title="投递安全摘要"><template v-if="status"><p>{{ status.enabled ? '投递循环开启' : '投递关闭' }} · {{ status.healthy ? '状态健康' : '需检查' }}</p><p>待处理 {{ status.pending }} · 重试 {{ status.retry }} · 推送服务 accepted {{ status.accepted }} · 失败 {{ status.failed }}</p><p v-if="status.lastErrorCode">错误码：{{ status.lastErrorCode }}</p></template><p v-else class="muted">投递状态未知，未将错误视作健康。</p><p class="muted">accepted 仅表示推送服务接受，不证明手机展示或用户已读。iPhone 添加主屏幕、授权、锁屏 / 关闭 PWA 后推送及点击跳转，均留待用户人工验证。</p></n-card></notification-layout></template>
