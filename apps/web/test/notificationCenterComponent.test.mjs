import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive } from 'vue'
import * as notifications from '../src/notifications.ts'
import { date } from '../src/api.ts'
import { compileCurrentSfc, flushSfc, mountScript } from './sfcHarness.mjs'

const at='2026-10-29T12:00:00.000Z',readAt='2026-10-29T12:01:00.000Z'
const delivery={pending:0,retry:0,sending:0,accepted:0,failed:0,skipped:0}
async function center(t) {
  const route=reactive({query:{id:'n-a'}}), counts={lists:0,events:0,patches:0}
  const server=new Map(['n-a','n-b'].map(id=>[id,{id,kind:'test',title:`合成通知 ${id}`,body:'合成正文',createdAt:at,readAt:id==='n-b'?at:null,runId:null,entityId:null,versionId:null,delivery}]))
  let pending,finished=false
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    const path=new URL(url,'https://app.invalid').pathname
    if(path==='/api/v1/notifications') {counts.lists++;return Response.json({items:[...server.values()],nextCursor:null})}
    const id=path.split('/').at(-1)
    if(options.method==='PATCH') {
      counts.patches++;assert.deepEqual(JSON.parse(options.body),{read:true})
      return new Promise(resolve=>{pending=(invalid=false)=>{
        server.set(id,{...server.get(id),readAt})
        resolve(Response.json({notification:{...server.get(id),...(invalid?{readAt:null}: {})}}))
      }})
    }
    assert(server.has(id));return Response.json({notification:server.get(id)})
  })
  const document={hidden:false,addEventListener(){},removeEventListener(){}}
  const component=await compileCurrentSfc('NotificationCenter.vue',{
    'vue-router':{useRoute:()=>route,useRouter:()=>({push(){}})},
    './api':{date},'./notifications':notifications,
    './useUnread':{notificationsChanged(){counts.events++}},
    './NotificationLayout.vue':{default:{}}
  },{globals:{document}})
  const mounted=mountScript(component)
  const unmount=()=>{if(!finished){finished=true;mounted.unmount()}}
  t.after(unmount)
  for(let i=0;i<10 && !pending;i++) await flushSfc()
  assert.equal(counts.patches,1,'真实SFC应在成功查看n-a后发起一次pending PATCH')
  assert.equal(mounted.state.detail.id,'n-a');assert.equal(mounted.state.items.find(n=>n.id==='n-a').readAt,null)
  return {...mounted,unmount,route,counts,server,finishPatch:invalid=>pending(invalid)}
}
for(const [name,query,selected] of [['关闭详情',{},null],['切到另一条已读通知',{id:'n-b'},'n-b']]) {
  test(`R1 真实SFC：PATCH pending时${name}，成功后仍刷新列表/角标但不覆盖当前详情`,async t=>{
    const h=await center(t)
    h.route.query=query;await flushSfc()
    assert.equal(h.state.detail?.id??null,selected)
    const lists=h.counts.lists
    h.finishPatch();await flushSfc()
    assert.equal(h.server.get('n-a').readAt,readAt)
    assert.equal(h.counts.events,1,'成功写请求必须广播一次notifications-changed')
    assert.equal(h.counts.lists,lists+1,'成功写请求必须重新读取列表事实')
    assert.equal(h.state.items.find(n=>n.id==='n-a').readAt,readAt)
    assert.equal(h.state.detail?.id??null,selected,'旧PATCH不得重新打开或覆写当前详情')
    if(selected) assert.equal(h.state.detail.readAt,at)
    assert.equal(h.counts.patches,1,'切换到已读通知不得新增PATCH')
  })
}
test('R1 真实SFC：关闭详情后的无效PATCH DTO不发送成功事件、不触发成功列表刷新',async t=>{
  const h=await center(t);h.route.query={};await flushSfc();const lists=h.counts.lists
  h.finishPatch(true);await flushSfc()
  assert.equal(h.counts.events,0);assert.equal(h.counts.lists,lists);assert.equal(h.state.detail,null)
  assert.equal(h.state.items.find(n=>n.id==='n-a').readAt,null)
})
test('R1 真实SFC：卸载后pending PATCH成功也不能同步已销毁组件',async t=>{
  const h=await center(t);const lists=h.counts.lists;h.unmount();h.finishPatch();await flushSfc()
  assert.equal(h.counts.events,0);assert.equal(h.counts.lists,lists);assert.equal(h.state.detail,null)
})
