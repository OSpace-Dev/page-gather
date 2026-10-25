<script setup lang="ts">
import { ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NCard, NForm, NFormItem, NInput, NButton, NAlert } from 'naive-ui'
import { api } from './api'
const route = useRoute(), router = useRouter()
const username = ref('admin'), password = ref(''), busy = ref(false), error = ref('')
async function login() {
  if (busy.value) return
  error.value = ''
  if (!username.value || !password.value) { error.value = '请输入管理员用户名和密码。'; return }
  busy.value = true
  try { await api('/auth/login', 'POST', { username: username.value, password: password.value }); password.value = ''; const target = String(route.query.redirect ?? '/overview'); await router.replace(target.startsWith('/') && !target.startsWith('//') && !target.startsWith('/login') ? target : '/overview') }
  catch (e) { error.value = e instanceof Error ? e.message : '登录失败，请重试。'; password.value = '' }
  finally { busy.value = false }
}
</script>
<template><main class="login"><div class="login-wrap"><div class="brand">PAGE GATHER <span>采集工作台</span></div><n-card title="管理员登录"><p class="muted">登录后查看任务、采集进度与项目 README。</p><n-alert v-if="route.query.expired" type="warning" class="gap">登录已失效，请重新登录。</n-alert><n-alert v-if="error" type="error" class="gap" role="alert">{{ error }}</n-alert><n-form @submit.prevent="login"><n-form-item label="用户名"><n-input v-model:value="username" autocomplete="username" placeholder="管理员用户名" /></n-form-item><n-form-item label="密码"><n-input v-model:value="password" type="password" autocomplete="current-password" show-password-on="click" placeholder="请输入部署时设置的密码" /></n-form-item><n-button attr-type="submit" type="primary" block :loading="busy">登录</n-button></n-form></n-card><p class="muted">仅管理员可访问 · 密码由部署者设置</p></div></main></template>
