<script setup lang="ts">
import { useUnread } from './useUnread'
const { count, error } = useUnread()
const nav = [{path:'/overview',title:'概览'},{path:'/tasks',title:'任务 / 手动采集'},{path:'/runs',title:'运行记录'},{path:'/entities',title:'项目资料库'},{path:'/notifications',title:'通知中心'},{path:'/notification-settings',title:'通知 / 设备设置'}]
</script>
<template><nav aria-label="主导航"><router-link v-for="item in nav" :key="item.path" :to="item.path" active-class="selected">{{ item.title }}<span v-if="item.path==='/notifications' && count!==null" class="unread-badge" :aria-label="`${count} 条未读`">{{ count > 99 ? '99+' : count }}</span><span v-else-if="item.path==='/notifications' && error" title="未读数量不可用" aria-label="未读数量不可用"> ?</span></router-link></nav></template>
