import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
const Workspace = () => import('./Workspace.vue')
const Login = () => import('./Login.vue')
import { api } from './api'
import './style.css'
import { initPwa } from './pwa'
import { loginRedirect } from './notifications'
const NotificationCenter = () => import('./NotificationCenter.vue')
const NotificationSettings = () => import('./NotificationSettings.vue')
export const router = createRouter({ history: createWebHistory(), routes: [
  { path: '/login', component: Login },
  { path: '/notifications', component: NotificationCenter },
  { path: '/notifications/:id', redirect: to => ({path:'/notifications',query:{id:String(to.params.id)}}) },
  { path: '/notification-settings', component: NotificationSettings },
  ...['overview','tasks','runs','entities'].map(name => ({ path: `/${name}`, component: Workspace, meta: { section: name } })),
  { path: '/', redirect: '/overview' }, { path: '/:pathMatch(.*)*', redirect: '/overview' }
] })
router.beforeEach(async to => {
  if (to.path === '/login') return true
  try { await api('/auth/me'); return true } catch { return { path: '/login', query: { redirect: loginRedirect(to.fullPath) } } }
})
window.addEventListener('session-expired', () => { if (router.currentRoute.value.path !== '/login') void router.replace({ path: '/login', query: { redirect: loginRedirect(router.currentRoute.value.fullPath), expired: '1' } }) })
initPwa()
createApp(App).use(router).mount('#app')
