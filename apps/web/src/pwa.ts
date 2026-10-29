import { ref } from 'vue'
export const updateAvailable = ref(false), pwaError = ref(''), installed = ref(false), installAvailable = ref(false), updateStatus = ref('')
interface InstallPrompt extends Event { prompt():Promise<void>; userChoice:Promise<{outcome:string}> }
let registration: ServiceWorkerRegistration | undefined, promptEvent: InstallPrompt | undefined, confirmedUpdate = false
export function initPwa() {
  installed.value = matchMedia('(display-mode: standalone)').matches || !!(navigator as Navigator & {standalone?:boolean}).standalone
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); promptEvent = event as InstallPrompt; installAvailable.value = true })
  window.addEventListener('appinstalled', () => { installed.value = true; installAvailable.value = false; promptEvent = undefined })
  if (!('serviceWorker' in navigator) || !isSecureContext) { pwaError.value = '安装与离线功能需要支持 Service Worker 的安全上下文。'; return }
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (confirmedUpdate) { confirmedUpdate = false; location.reload() } })
  void navigator.serviceWorker.register('/sw.js',{scope:'/',updateViaCache:'none'}).then(reg => {
    registration = reg; updateStatus.value = '离线组件已注册。更新不会自动刷新页面。'
    if (reg.waiting) updateAvailable.value = true
    reg.addEventListener('updatefound', () => { const worker = reg.installing; worker?.addEventListener('statechange', () => { if (worker.state === 'installed' && navigator.serviceWorker.controller) updateAvailable.value = true }) })
  }).catch(() => { pwaError.value = '离线组件注册失败，站内通知仍可在线使用，请稍后刷新重试。' })
}
export function applyUpdateFromClick() {
  if (!registration?.waiting) { updateAvailable.value = false; return }
  if (!window.confirm('发现新版本。更新会刷新页面，未保存的表单内容将丢失。确认现在更新？')) return
  confirmedUpdate = true
  registration.waiting.postMessage({type:'SKIP_WAITING'})
}
export async function installFromClick() {
  if (!promptEvent) return
  const event = promptEvent; promptEvent = undefined; installAvailable.value = false
  try { await event.prompt(); await event.userChoice } catch { pwaError.value = '浏览器未完成安装，请使用浏览器菜单添加到主屏幕。' }
}
export async function checkUpdateFromClick() {
  if (!registration) { updateStatus.value = '离线组件尚未就绪，请稍后刷新重试。'; return }
  updateStatus.value = '正在检查应用更新…'
  try { await registration.update(); if (registration.waiting) { updateAvailable.value = true; updateStatus.value = '有新版本，请确认后更新。' } else updateStatus.value = '已完成更新检查；新版本如下载完成会另行提示，不自动刷新。' } catch { pwaError.value = '检查更新失败，请检查网络后重试。'; updateStatus.value = '' }
}
