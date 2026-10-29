import { api, row } from './api.ts'
import { applicationServerKey, currentOwnedDevice, notificationsClient, parseDetail, parseDevice, subscriptionBody, validId } from './notifications.ts'
import type { PushConfig } from './notifications.ts'
export const deviceStorageKey = 'page-gather.push.device-id'
export function localDeviceId(): string | null { try { const id = localStorage.getItem(deviceStorageKey); return validId(id) ? id : null } catch { return null } }
function storeDevice(id: string | null) { try { if (id) localStorage.setItem(deviceStorageKey,id); else localStorage.removeItem(deviceStorageKey) } catch { throw new Error('无法保存本机设备标识，请允许本站本地存储后重试。') } }
export function pushUnavailable(): string {
  if (!globalThis.isSecureContext) return '推送需要 HTTPS 安全上下文（本地开发可用 localhost）。站内通知仍可用。'
  if (!('Notification' in globalThis) || !('serviceWorker' in navigator) || !('PushManager' in globalThis)) return '此浏览器暂不支持 Web Push。iOS/iPadOS 16.4 起，请先添加到主屏幕，再从图标打开并主动授权。'
  if (Notification.permission === 'denied') return '通知权限已被拒绝，请在系统或浏览器的本站设置中调整；不会自动再次弹窗。'
  return ''
}
// 只能由点击处理器调用；requestPermission 在第一个 await 前发起。
export async function subscribeFromClick(config: PushConfig, deviceLabel: string) {
  const reason = pushUnavailable()
  if (reason) throw new Error(reason)
  if (!config.configured || !config.enabled || !config.publicKey) throw new Error('服务器尚未开启或配置 Web Push；站内通知不受影响。')
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('尚未授予通知权限，没有创建设备订阅。')
  let timeout: ReturnType<typeof setTimeout> | undefined
  const registration = await Promise.race([navigator.serviceWorker.ready, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Service Worker 尚未就绪，请刷新后重试。')), 15000) })]).finally(() => { if (timeout) clearTimeout(timeout) })
  let subscription = await registration.pushManager.getSubscription()
  if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey:applicationServerKey(config.publicKey) })
  const device = parseDevice(row(await api('/push/subscriptions','POST',subscriptionBody(subscription.toJSON(),deviceLabel))).subscription)
  if (!device.owned || !device.enabled) throw new Error('服务器未确认本机订阅已续绑当前会话，未保存为可操作设备。')
  storeDevice(device.id)
  return device
}
export async function unsubscribeLocal(): Promise<string[]> {
  const warnings: string[] = []
  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.getRegistration('/')
      const sub = await registration?.pushManager.getSubscription()
      if (sub && !await sub.unsubscribe()) warnings.push('浏览器未确认本机退订，请在浏览器设置中检查。')
    } catch { warnings.push('本机退订失败，请在浏览器设置中检查；不能确认设备已完全退订。') }
  }
  return warnings
}
async function verifiedLocalDevice(enabled = false) {
  const id = localDeviceId(), devices = await notificationsClient.devices()
  if (devices.nextCursor) throw new Error('设备归属数据未完整读取，未执行本机操作，请刷新后重试。')
  if (id !== localDeviceId()) throw new Error('本机设备标识已变化，未执行操作，请刷新后重试。')
  return currentOwnedDevice(devices.items,id,enabled)
}
export async function removeLocalDevice() {
  const device = await verifiedLocalDevice()
  const warnings = await unsubscribeLocal()
  await api(`/push/subscriptions/${encodeURIComponent(device.id)}`, 'DELETE')
  storeDevice(null)
  return warnings
}
export async function testCurrentDevice(key: string) {
  const device = await verifiedLocalDevice(true)
  const result = parseDetail(await api('/push/test','POST',{subscriptionId:device.id},key))
  if (result.kind !== 'test') throw new Error('测试接口确认格式不匹配，未确认测试已受理；重试将复用同一请求标识。')
  return result
}
export async function logoutCurrentDevice() {
  let subscriptionId: string | undefined
  const warnings: string[] = []
  if (localDeviceId()) {
    try { subscriptionId = (await verifiedLocalDevice()).id }
    catch (e) { warnings.push(`未确认当前会话的设备归属，未请求服务器解绑：${e instanceof Error ? e.message : '请重新登记本机。'}`) }
  }
  warnings.push(...await unsubscribeLocal())
  await api('/auth/logout','POST',subscriptionId ? { subscriptionId } : {})
  try { storeDevice(null) } catch { warnings.push('本机设备标识无法从本地存储清除，请检查浏览器设置。') }
  if ('clearAppBadge' in navigator) try { await (navigator as Navigator & { clearAppBadge():Promise<void> }).clearAppBadge() } catch { /* 系统角标失败不冒称退订失败。 */ }
  window.dispatchEvent(new Event('personal-state-clear'))
  return warnings
}
