import test from 'node:test'
import assert from 'node:assert/strict'
import { applicationServerKey, loginRedirect, notificationLink, notificationsClient, originalTarget, parseCount, parseDetail, parseDevice, parseNotification, parsePushConfig, parsePushStatus, parseRule, ruleError, subscriptionBody } from '../src/notifications.ts'
const at='2026-10-29T12:00:00Z'
const notification={delivery:{pending:0,retry:0,sending:0,accepted:0,failed:0,skipped:0},id:'n-1',kind:'changed',title:'变化摘要',createdAt:at,readAt:null,runId:'r-1',entityId:'e-1',versionId:'v-1'}
const rule={id:'rule-1',name:'站内',enabled:true,taskIds:[],eventTypes:['baseline','created','changed'],keywords:[],pushEnabled:false}
test('规则默认站内、合法字段完整解析；拒绝未知事件、重复与超长输入',()=>{
  assert.equal(ruleError(rule),'');assert.equal(parseRule(rule).pushEnabled,false)
  for(const changed of [{name:' '},{name:'x'.repeat(201)},{eventTypes:[]},{eventTypes:['other']},{eventTypes:['changed','changed']},{keywords:['same','same']},{keywords:['x'.repeat(201)]},{taskIds:['bad/id']},{enabled:'true'},{pushEnabled:undefined}]) {assert.notEqual(ruleError({...rule,...changed}),'');assert.throws(()=>parseRule({...rule,...changed}))}
})
test('详情必须为notification包装，body只保留文本；invalidDTO不能假装已读',()=>{
  const detail=parseDetail({notification:{...notification,body:'<script>仅文本</script>'}})
  assert.equal(detail.body,'<script>仅文本</script>');assert.equal(detail.readAt,null)
  for(const value of [notification,{notification},{notification:{...notification,body:{html:'bad'}}},{notification:{...notification,body:'text',readAt:true}},{notification:{...notification,body:'text',createdAt:'bad'}}]) assert.throws(()=>parseDetail(value))
  assert.throws(()=>parseNotification({...notification,versionId:undefined}))
})
test('通知原目标仅使用冻结run/entity/version字段，忽略服务端任意targetPath',()=>{
  assert.equal(originalTarget({...notification,targetPath:'https://other.example'}),'/runs?runId=r-1&entityId=e-1&versionId=v-1')
  assert.equal(originalTarget({...notification,entityId:null,versionId:null}),'/runs?runId=r-1')
  assert.equal(originalTarget({...notification,entityId:null,versionId:null,runId:null}),undefined)
  assert.equal(notificationLink('n-1'),'/notifications?id=n-1');assert.equal(notificationLink('bad/id'),undefined)
})
test('登录重定向保留合法通知/历史版本目标，不允许开放跳转或登录循环',()=>{
  for(const path of ['/notifications?id=n-1','/runs?runId=r-1','/entities?entityId=e-1&versionId=v-1','/notification-settings']) assert.equal(loginRedirect(path),path)
  for(const path of ['https://other.example','//other.example','/\\other.example','/login?redirect=/tasks','/%2fother.example','/notifications?id=bad%2Fid','/notifications?id=a&id=b','/notifications?redirect=https://other.example','/notifications#body','/api/v1/auth/logout']) assert.equal(loginRedirect(path),'/overview',path)
})
test('推送公钥转换为65字节P256 applicationServerKey，不接受私钥或损坏公钥',()=>{
  const bytes=Buffer.alloc(65);bytes[0]=4
  assert.deepEqual([...applicationServerKey(bytes.toString('base64url'))],[...bytes])
  for(const key of ['secret','=',Buffer.alloc(32).toString('base64url'),Buffer.alloc(65).toString('base64url')]) assert.throws(()=>applicationServerKey(key))
})
test('订阅请求标准嵌套DTO与keys命名，不混入浏览器额外字段',()=>{
  const subscription={endpoint:'https://web.push.apple.com/synthetic',expirationTime:null,keys:{p256dh:'synthetic-public',auth:'synthetic-auth'},extra:'ignored'}
  const body=subscriptionBody(subscription,'合成设备')
  assert.deepEqual(body,{subscription:{endpoint:subscription.endpoint,expirationTime:null,keys:subscription.keys},deviceLabel:'合成设备'})
  for(const changed of [{keys:{}},{keys:{publicKey:'x',auth:'x'}},{expirationTime:'tomorrow'},{endpoint:null}]) assert.throws(()=>subscriptionBody({...subscription,...changed},'合成设备'))
})
test('设备仅安全元数据；配置缺VAPID不是站内错误；status严格使用counts',()=>{
  const device={id:'d-1',deviceLabel:'合成设备',enabled:true,createdAt:at,updatedAt:at,owned:true}
  assert.equal(parseDevice(device).id,'d-1')
  for(const field of ['endpoint','keys','auth','p256dh']) assert.throws(()=>parseDevice({...device,[field]:'secret'}))
  assert.equal(parsePushConfig({configured:false,enabled:false,publicKey:null,reason:'PUSH_DISABLED'}).configured,false)
  assert.throws(()=>parsePushConfig({configured:true,enabled:true,publicKey:null,reason:null}))
  const counts={pending:1,retry:2,accepted:3,failed:4,sending:0,skipped:0}
  assert.equal(parsePushStatus({enabled:true,healthy:true,counts,lastErrorCode:null}).accepted,3)
  assert.throws(()=>parsePushStatus({enabled:true,healthy:true,...counts,lastErrorCode:null}))
  assert.throws(()=>parseCount({count:-1}));assert.throws(()=>parseCount({count:'3'}));assert.equal(parseCount({count:3}),3)
})
test('PATCH已读必须确认同一id和非null readAt；错误DTO不生成本地成功结果',async t=>{
  const old=globalThis.fetch;t.after(()=>{globalThis.fetch=old})
  for(const response of [{notification:{...notification,body:'text'}},{notification:{...notification,id:'other',body:'text',readAt:at}},{notification:{...notification,body:42,readAt:at}}]) {
    globalThis.fetch=async()=>new Response(JSON.stringify(response),{status:200})
    await assert.rejects(notificationsClient.read('n-1'))
  }
  globalThis.fetch=async(url,options)=>{assert.equal(url,'/api/v1/notifications/n-1');assert.equal(options.method,'PATCH');assert.equal(options.cache,'no-store');assert.deepEqual(JSON.parse(options.body),{read:true});return new Response(JSON.stringify({notification:{...notification,body:'text',readAt:at}}))}
  assert.equal((await notificationsClient.read('n-1')).readAt,at)
})
