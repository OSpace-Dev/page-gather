import test from 'node:test'
import assert from 'node:assert/strict'
import { deviceStorageKey, localDeviceId, logoutCurrentDevice, pushUnavailable, removeLocalDevice, subscribeFromClick, testCurrentDevice } from '../src/push.ts'
const at='2026-10-29T12:00:00Z',bytes=Buffer.alloc(65);bytes[0]=4
const config={configured:true,enabled:true,publicKey:bytes.toString('base64url'),reason:null}
function setup(t) {
  const descriptors=new Map(),order=[],requests=[],storage=new Map(),events=[]
  const devices=[{id:'d-local',deviceLabel:'合成本机',enabled:true,owned:true,createdAt:at,updatedAt:at},{id:'d-other',deviceLabel:'合成其他设备',enabled:true,owned:true,createdAt:at,updatedAt:at}]
  function global(name,value) {descriptors.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{configurable:true,writable:true,value})}
  const subscription={toJSON(){return {endpoint:'https://web.push.apple.com/synthetic',expirationTime:null,keys:{p256dh:'synthetic-public',auth:'synthetic-auth'}}},async unsubscribe(){order.push('unsubscribe');return true}}
  const registration={pushManager:{async getSubscription(){order.push('getSubscription');return null},async subscribe(options){order.push('subscribe');assert.equal(options.userVisibleOnly,true);assert.equal(options.applicationServerKey.length,65);return subscription}}}
  const serviceWorker={get ready(){order.push('ready');return Promise.resolve(registration)},async getRegistration(){return registration}}
  global('isSecureContext',true)
  global('Notification',{permission:'default',async requestPermission(){order.push('permission');return 'granted'}})
  global('PushManager',class {})
  global('navigator',{serviceWorker,async clearAppBadge(){order.push('clearBadge')}})
  global('localStorage',{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)})
  global('window',{dispatchEvent:e=>events.push(e.type)})
  global('fetch',async(url,options)=>{
    order.push('api');requests.push({url,options})
    const value=options.method==='GET' ? {items:devices,nextCursor:null} : url==='/api/v1/push/test' ? {notification:{id:'n-test',kind:'test',title:'推送测试',body:'合成测试摘要',taskId:null,runId:null,entityId:null,versionId:null,targetPath:'/notifications',createdAt:at,readAt:null,dedupeKey:'test:synthetic',matchedRuleIds:[],delivery:{pending:1,retry:0,sending:0,accepted:0,failed:0,skipped:0}}} : {subscription:{id:'d-1',deviceLabel:'合成设备',enabled:true,owned:true,createdAt:at,updatedAt:at}}
    return new Response(JSON.stringify(value),{status:200})
  })
  t.after(()=>{for(const [name,descriptor] of descriptors) if(descriptor) Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name]})
  return {order,requests,storage,registration,subscription,events,devices}
}
test('只读能力检查不自动申请权限或订阅；主动点击顺序permission→ready→subscribe',async t=>{
  const h=setup(t)
  assert.equal(pushUnavailable(),'');assert.deepEqual(h.order,[])
  const device=await subscribeFromClick(config,'合成设备')
  assert.equal(device.id,'d-1');assert.deepEqual(h.order,['permission','ready','getSubscription','subscribe','api'])
  assert.deepEqual([...h.storage.entries()],[[deviceStorageKey,'d-1']])
  const body=JSON.parse(h.requests[0].options.body)
  assert.equal(body.subscription.endpoint,'https://web.push.apple.com/synthetic');assert.equal(body.subscription.keys.p256dh,'synthetic-public');assert.equal(body.deviceLabel,'合成设备')
})
test('拒绝权限不读取ready、不订阅、不发服务器请求',async t=>{
  const h=setup(t);Notification.requestPermission=async()=>{h.order.push('permission');return 'denied'}
  await assert.rejects(subscribeFromClick(config,'合成设备'),/尚未授予/)
  assert.deepEqual(h.order,['permission']);assert.equal(h.storage.size,0)
})
test('不安全上下文、无配置、已拒绝与缺能力都不给权限弹窗',async t=>{
  const h=setup(t)
  globalThis.isSecureContext=false;await assert.rejects(subscribeFromClick(config,'合成设备'),/HTTPS/)
  globalThis.isSecureContext=true;await assert.rejects(subscribeFromClick({...config,configured:false},'合成设备'),/服务器/)
  Notification.permission='denied';await assert.rejects(subscribeFromClick(config,'合成设备'),/拒绝/)
  Notification.permission='default';delete globalThis.PushManager;await assert.rejects(subscribeFromClick(config,'合成设备'),/主屏幕/)
  assert.deepEqual(h.order,[])
})
test('本机解除浏览器订阅并DELETE仅本机id，不影响其他设备',async t=>{
  const h=setup(t);h.storage.set(deviceStorageKey,'d-local');h.registration.pushManager.getSubscription=async()=>h.subscription
  assert.deepEqual(await removeLocalDevice(),[])
  assert.equal(h.requests.length,2);assert.equal(h.requests[0].options.method,'GET');assert.equal(h.requests[1].url,'/api/v1/push/subscriptions/d-local');assert.equal(h.requests[1].options.method,'DELETE');assert.equal(h.storage.size,0);assert.deepEqual(h.order,['api','unsubscribe','api'])
})
test('登出携带可选本机subscriptionId，先unsubscribe，成功清状态/角标',async t=>{
  const h=setup(t);h.storage.set(deviceStorageKey,'d-local');h.registration.pushManager.getSubscription=async()=>h.subscription
  assert.deepEqual(await logoutCurrentDevice(),[])
  assert.equal(h.requests.length,2);assert.equal(h.requests[1].url,'/api/v1/auth/logout');assert.deepEqual(JSON.parse(h.requests[1].options.body),{subscriptionId:'d-local'})
  assert.deepEqual(h.order,['api','unsubscribe','api','clearBadge']);assert.deepEqual(h.events,['personal-state-clear']);assert.equal(localDeviceId(),null)
})
test('本机退订失败仍尝试登出但返回明确warning；无id不提交其他设备',async t=>{
  const h=setup(t);h.registration.pushManager.getSubscription=async()=>({...h.subscription,async unsubscribe(){throw Error('unavailable')}})
  const warnings=await logoutCurrentDevice();assert.equal(warnings.length,1);assert.match(warnings[0],/不能确认/);assert.deepEqual(JSON.parse(h.requests[0].options.body),{})
})
test('owned=false或缺失时不DELETE、不测试、不伪造浏览器退订完成',async t=>{
  const h=setup(t);h.storage.set(deviceStorageKey,'d-local');h.devices[0].owned=false
  await assert.rejects(removeLocalDevice(),/重新登记/)
  await assert.rejects(testCurrentDevice('synthetic-key'),/重新登记/)
  assert(h.requests.every(r=>r.options.method==='GET'));assert(!h.order.includes('unsubscribe'));assert.equal(localDeviceId(),'d-local')
  delete h.devices[0].owned
  await assert.rejects(testCurrentDevice('synthetic-key'),/格式不匹配/)
  assert(h.requests.every(r=>r.options.method==='GET'))
})
test('测试只选本机且当前session owned设备，不能用其他owned设备替代',async t=>{
  const h=setup(t);h.storage.set(deviceStorageKey,'d-local')
  const result=await testCurrentDevice('synthetic-key')
  assert.equal(result.kind,'test');assert.equal(result.delivery.pending,1)
  assert.equal(h.requests.length,2);assert.equal(h.requests[1].url,'/api/v1/push/test');assert.equal(h.requests[1].options.headers['Idempotency-Key'],'synthetic-key');assert.deepEqual(JSON.parse(h.requests[1].options.body),{subscriptionId:'d-local'})
  h.devices.splice(0,1)
  await assert.rejects(testCurrentDevice('synthetic-key-2'),/重新登记/)
  assert.equal(h.requests.at(-1).options.method,'GET')
})
test('会话过期后主动POST浏览器现有订阅同keys续绑，不重新subscribe或将metadata当授权',async t=>{
  const h=setup(t);h.storage.set(deviceStorageKey,'d-local');h.devices[0].owned=false
  h.registration.pushManager.getSubscription=async()=>{h.order.push('existingSubscription');return h.subscription}
  const before=h.subscription.toJSON(),fetchMock=globalThis.fetch
  globalThis.fetch=async(url,options)=>{await fetchMock(url,options);return new Response(JSON.stringify({subscription:{...h.devices[0],owned:true}}),{status:201})}
  const device=await subscribeFromClick(config,'续绑合成设备')
  assert.equal(device.owned,true);assert(!h.order.includes('subscribe'));assert.equal(h.requests.length,1);assert.equal(h.requests[0].options.method,'POST');assert.deepEqual(JSON.parse(h.requests[0].options.body).subscription,before);assert.equal(localDeviceId(),'d-local')
})
test('订阅响应未确认owned不保存id，读取归属数据不足明确失败',async t=>{
  const h=setup(t)
  globalThis.fetch=async()=>new Response(JSON.stringify({subscription:{id:'d-local',deviceLabel:'合成设备',enabled:true,owned:false,createdAt:at,updatedAt:at}}))
  await assert.rejects(subscribeFromClick(config,'合成设备'),/未确认/);assert.equal(h.storage.size,0)
  h.storage.set(deviceStorageKey,'d-local')
  globalThis.fetch=async()=>new Response(JSON.stringify({items:[],nextCursor:'incomplete'}))
  await assert.rejects(removeLocalDevice(),/未完整/)
  globalThis.fetch=async()=>new Response(JSON.stringify({items:[{id:'d-local'}],nextCursor:null}))
  await assert.rejects(testCurrentDevice('synthetic-key'),/格式不匹配/)
})
test('非当前session归属的旧本机id登出时不传subscriptionId，明确警告未服务器解绑',async t=>{
  const h=setup(t);h.storage.set(deviceStorageKey,'d-local');h.devices[0].owned=false;h.registration.pushManager.getSubscription=async()=>h.subscription
  const warnings=await logoutCurrentDevice()
  assert(warnings.some(w=>w.includes('未请求服务器解绑')));assert.deepEqual(JSON.parse(h.requests[1].options.body),{});assert.equal(h.requests[1].url,'/api/v1/auth/logout');assert(!h.requests.some(r=>r.options.method==='DELETE'));assert.equal(localDeviceId(),null)
})
