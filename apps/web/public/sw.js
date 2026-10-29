/* 仅公开 app shell；构建器替换这两个常量，不缓存任何 API 或个人正文。 */
const VERSION = '__PWA_VERSION__'
const PRECACHE = /* __PWA_PRECACHE__ */ ['/offline.html']
const CACHE_PREFIX = 'page-gather-public-'
const CACHE_NAME = CACHE_PREFIX + VERSION
const ID = /^[A-Za-z0-9_-]{1,160}$/
function safeNotificationUrl(value, notificationId) {
  const fallback = ID.test(typeof notificationId === 'string' ? notificationId : '') ? '/notifications?id=' + encodeURIComponent(notificationId) : '/notifications'
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020]/.test(value)) return fallback
  try {
    const url = new URL(value, self.location.origin)
    if (url.origin !== self.location.origin || url.hash) return fallback
    const detail = url.pathname.match(/^\/notifications\/([A-Za-z0-9_-]{1,160})$/)
    if (detail && !url.search) return '/notifications?id=' + encodeURIComponent(detail[1])
    if (url.pathname !== '/notifications') return fallback
    const entries = [...url.searchParams]
    if (entries.length > 2 || entries.some(([key, id]) => !['id','notificationId'].includes(key) || !ID.test(id) || url.searchParams.getAll(key).length !== 1)) return fallback
    const ids = entries.map(([,id])=>id)
    if (new Set(ids).size > 1) return fallback
    return ids.length ? '/notifications?id=' + encodeURIComponent(ids[0]) : '/notifications'
  } catch { return fallback }
}
function publicAsset(request) {
  const url = new URL(request.url)
  return request.method === 'GET' && url.origin === self.location.origin && !url.search && PRECACHE.includes(url.pathname) && url.pathname !== '/index.html' && url.pathname !== '/offline.html'
}
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE.map(path => new Request(new URL(path, self.location.origin), { credentials:'omit', cache:'reload' })))) )
  // 不在安装时 skipWaiting；必须由用户确认更新。
})
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) await caches.delete(name)
    await self.clients.claim()
  })())
})
self.addEventListener('message', event => {
  if (event.data?.type !== 'SKIP_WAITING' || !event.source || event.source.type !== 'window') return
  try { if (new URL(event.source.url).origin !== self.location.origin) return } catch { return }
  event.waitUntil(self.skipWaiting())
})
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  // API/auth 请求只经过网络；即使离线也绝不返回 shell 或缓存数据。
  if (/^\/(?:api|auth)(?:\/|$)/.test(url.pathname)) {
    event.respondWith(fetch(new Request(request, { cache:'no-store' })))
    return
  }
  if (request.method !== 'GET') return
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try { return await fetch(new Request(request, { cache:'no-store' })) }
      catch { return (await (await caches.open(CACHE_NAME)).match('/offline.html')) || new Response('离线：请联网后重新打开采集工作台。', { status:503, headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'} }) }
    })())
    return
  }
  if (publicAsset(request)) event.respondWith((async () => (await (await caches.open(CACHE_NAME)).match(url.pathname)) || fetch(new Request(request,{cache:'no-store'})))())
  // README、通知数据和任意非白名单资源不读取也不写入缓存。
})
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let payload = {}
    try { const value = event.data?.json(); if (value && typeof value === 'object' && !Array.isArray(value)) payload = value } catch { /* 坏载荷仍展示通用可见通知。 */ }
    const id = typeof payload.notificationId === 'string' && ID.test(payload.notificationId) ? payload.notificationId : undefined
    await self.registration.showNotification('采集工作台', {
      body:'有新的站内消息，请打开应用查看。', icon:'/icons/icon-192.png', badge:'/icons/icon-192.png',
      tag:id ? 'notification-' + id : 'page-gather-generic',
      data:{url:safeNotificationUrl(payload.targetPath,id)}
    })
  })())
})
self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil((async () => {
    const path = safeNotificationUrl(event.notification.data?.url), target = new URL(path,self.location.origin).href
    const windows = await self.clients.matchAll({type:'window',includeUncontrolled:true})
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue
      try {
        if (typeof client.navigate === 'function') { const navigated = await client.navigate(target); if (navigated) { await navigated.focus(); return } }
        if (client.url === target) { await client.focus(); return }
      } catch { /* 旧窗口无法导航时尝试其他窗口或打开安全目标。 */ }
    }
    await self.clients.openWindow(target)
  })())
})
