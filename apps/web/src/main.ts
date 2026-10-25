import { createApp } from 'vue'
import { createRouter, createWebHistory } from 'vue-router'
import App from './App.vue'
const Workspace = () => import('./Workspace.vue')
const Login = () => import('./Login.vue')
import { api } from './api'
import './style.css'
export const router = createRouter({ history: createWebHistory(), routes: [
  { path: '/login', component: Login },
  ...['overview','tasks','runs','entities'].map(name => ({ path: `/${name}`, component: Workspace, meta: { section: name } })),
  { path: '/', redirect: '/overview' }, { path: '/:pathMatch(.*)*', redirect: '/overview' }
] })
router.beforeEach(async to => {
  if (to.path === '/login') return true
  try { await api('/auth/me'); return true } catch { return { path: '/login', query: { redirect: to.fullPath } } }
})
window.addEventListener('session-expired', () => { if (router.currentRoute.value.path !== '/login') void router.replace({ path: '/login', query: { redirect: router.currentRoute.value.fullPath, expired: '1' } }) })
createApp(App).use(router).mount('#app')
