import { onBeforeUnmount, ref } from 'vue'
import { notificationsClient } from './notifications.ts'
export function useUnread() {
  const count = ref<number|null>(null), error = ref('')
  let timer: ReturnType<typeof setTimeout> | undefined, disposed = false, pending = false, generation = 0
  const stop = () => { if (timer) clearTimeout(timer); timer = undefined }
  async function refresh() {
    if (disposed || pending || document.hidden) return
    pending = true
    const request = generation
    try {
      const result = await notificationsClient.unread()
      if (disposed || request !== generation || document.hidden) return
      count.value = result; error.value = ''
      const badge = navigator as Navigator & { setAppBadge?(n:number):Promise<void>; clearAppBadge?():Promise<void> }
      try { if (result) await badge.setAppBadge?.(result); else await badge.clearAppBadge?.() } catch { /* 系统角标仅增强，不影响站内事实。 */ }
    } catch (e) { if (!disposed && request === generation) { count.value = null; error.value = e instanceof Error ? e.message : '未读数量不可用' } }
    finally { pending = false; stop(); if (!disposed && !document.hidden) timer = setTimeout(() => void refresh(),30000) }
  }
  function visibility() { stop(); generation++; if (!document.hidden) void refresh() }
  function clear() { generation++; stop(); count.value = null; error.value = '' }
  const changed = () => void refresh()
  document.addEventListener('visibilitychange',visibility)
  window.addEventListener('notifications-changed',changed)
  window.addEventListener('personal-state-clear',clear)
  void refresh()
  onBeforeUnmount(() => { disposed = true; generation++; stop(); document.removeEventListener('visibilitychange',visibility); window.removeEventListener('notifications-changed',changed); window.removeEventListener('personal-state-clear',clear) })
  return { count, error, refresh }
}
export function notificationsChanged() { window.dispatchEvent(new Event('notifications-changed')) }
