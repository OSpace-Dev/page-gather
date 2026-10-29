import test from 'node:test'
import assert from 'node:assert/strict'
import { createSSRApp, h, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { parse as parseHtml } from '@vue/compiler-dom'
import { setup as setupSsrStyles } from '@css-render/vue3-ssr'
import * as api from '../src/api.ts'
import * as notifications from '../src/notifications.ts'
import { compileCurrentSfc } from './sfcHarness.mjs'

async function settingsHtml() {
  const counts={pending:0,retry:0,sending:0,accepted:0,failed:0,skipped:0}
  const component=await compileCurrentSfc('NotificationSettings.vue',{
    './api':{...api,async api(path){
      if(path.startsWith('/tasks?')) return {items:[],nextCursor:null}
      if(path==='/push/config') return {configured:false,publicKey:null,enabled:false,reason:'PUSH_DISABLED'}
      if(path==='/push/status') return {enabled:false,healthy:true,counts,lastErrorCode:null}
      throw new Error('SSR不允许写请求或其他API')
    }},
    './notifications':{...notifications,notificationsClient:{async rules(){return {items:[],nextCursor:null}},async devices(){return {items:[],nextCursor:null}}}},
    './push':{localDeviceId:()=>null,pushUnavailable:()=>'',removeLocalDevice:forbidden,subscribeFromClick:forbidden,testCurrentDevice:forbidden},
    './useUnread':{notificationsChanged:forbidden},
    './pwa':{checkUpdateFromClick:forbidden,installAvailable:ref(false),installed:ref(false),installFromClick:forbidden,updateStatus:ref('')},
    './NotificationLayout.vue':{default:{setup(_props,{slots}){return ()=>h('main',slots.default?.())}}}
  },{ssr:true})
  const setup=component.setup
  component.setup=(props,context)=>{const state=setup(props,context);state.edit();return state}
  const app=createSSRApp(component),errors=[]
  setupSsrStyles(app)
  app.config.errorHandler=error=>errors.push(error)
  const html=await renderToString(app)
  assert.deepEqual(errors,[],'真实NaiveUI SSR不得吞组件渲染异常')
  return html
}
function forbidden(){throw new Error('SSR不得主动申请权限、写数据或发送推送')}
function elements(html) {
  const nodes=[]
  function visit(node) {
    if(node.type===1) nodes.push({tag:node.tag,attrs:Object.fromEntries(node.props.filter(p=>p.type===6).map(p=>[p.name,p.value?.content??''])),node})
    for(const child of node.children??[]) visit(child)
  }
  visit(parseHtml(html));return nodes
}
function content(node){return (node.children??[]).map(n=>n.type===2?n.content:content(n)).join('').trim()}
const rendered=settingsHtml()

test('R2 当前SFC+真实NaiveUI SSR：规则名称、关键词和设备名的label for关联实际input/textarea',async()=>{
  const nodes=elements(await rendered)
  for(const [id,tag,name,labelText] of [
    ['notification-rule-name','input','ruleName','名称'],
    ['notification-rule-keywords','textarea','ruleKeywords','关键词（每行一个，留空表示不限制）'],
    ['notification-device-label','input','deviceLabel','本机设备名称']
  ]) {
    const controls=nodes.filter(n=>n.attrs.id===id)
    assert.equal(controls.length,1,`${id}必须唯一且落到原生控件，不是NInput外包装`)
    assert.equal(controls[0].tag,tag);assert.equal(controls[0].attrs.name,name)
    const label=nodes.find(n=>n.tag==='label'&&n.attrs.for===id)
    assert(label,`${id}必须有真实label[for]`);assert.equal(content(label.node),labelText)
  }
})
test('R2 当前SFC+真实NaiveUI SSR：两个role=switch均以aria-labelledby取得可见名称',async()=>{
  const nodes=elements(await rendered),switches=nodes.filter(n=>n.attrs.role==='switch')
  assert.equal(switches.length,2)
  for(const [labelId,text] of [['notification-rule-enabled-label','启用规则'],['notification-rule-push-label','允许本规则发送设备推送（默认关闭）']]) {
    const control=switches.find(n=>n.attrs['aria-labelledby']===labelId)
    assert(control,`${labelId}必须关联实际role=switch元素`)
    const labels=nodes.filter(n=>n.attrs.id===labelId)
    assert.equal(labels.length,1);assert.equal(labels[0].tag,'label');assert.equal(content(labels[0].node),text)
  }
})
test('R2 当前SFC+真实NaiveUI SSR：任务/事件选择的原生搜索控件有id、label和aria名称',async()=>{
  const nodes=elements(await rendered)
  for(const [id,labelText] of [['notification-rule-tasks','任务（留空表示全部）'],['notification-rule-events','事件类型']]) {
    const input=nodes.find(n=>n.tag==='input'&&n.attrs.id===id)
    assert(input,`${id}必须传入真实NSelect搜索input`)
    const label=nodes.find(n=>n.tag==='label'&&n.attrs.for===id)
    assert(label);assert.equal(label.attrs.id,input.attrs['aria-labelledby']);assert.equal(content(label.node),labelText)
  }
})
