import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
const source = await readFile(new URL('../public/sw.js',import.meta.url),'utf8')
const origin = 'https://app.example'
function harness() {
  const handlers = {}, shows = [], network = [], added = [], cacheReads = [], opened = [], cacheDeletes = [], messages = []
  const entries = new Map([['/offline.html', {publicOffline:true}]])
  const cache = { async addAll(requests) { added.push(...requests) }, async match(path) { cacheReads.push(path); return entries.get(path) } }
  class RequestMock {
    constructor(input, options={}) { Object.assign(this,typeof input==='object' && !(input instanceof URL) ? input : {url:String(input)},options); this.method??='GET'; this.credentials??='same-origin'; this.mode??='cors' }
  }
  const clients = { async claim() {}, async matchAll() { return [] }, async openWindow(url) { opened.push(url) } }
  const context = vm.createContext({URL,Request:RequestMock,Response,console,
    caches:{async open(){return cache},async keys(){return ['unrelated','page-gather-public-old']},async delete(name){cacheDeletes.push(name)}},
    fetch:async request=>{network.push(request);return {fromNetwork:true}},
    self:{location:{origin},registration:{async showNotification(title,options){shows.push({title,...options})}},clients,async skipWaiting(){messages.push('skipWaiting')},addEventListener(name,fn){handlers[name]=fn}}
  })
  vm.runInContext(source,context)
  async function dispatch(name, values={}) { const promises=[]; let response; handlers[name]({...values,waitUntil(p){promises.push(p)},respondWith(p){response=p}}); await Promise.all(promises); return response ? await response : undefined }
  return {context,handlers,shows,network,added,entries,cacheReads,opened,cacheDeletes,messages,clients,dispatch}
}
for(const [name,data] of [['empty',undefined],['invalid JSON',{json(){throw Error('invalid')}}],['array',{json(){return []}}],['null',{json(){return null}}],['primitive',{json(){return 'x'}}]]) {
  test(`push ${name} 始终尝试可见通用通知`,async()=>{const h=harness();await h.dispatch('push',{data});assert.equal(h.shows.length,1);assert.equal(h.shows[0].body,'有新的站内消息，请打开应用查看。');assert.equal(h.network.length,0)})
}
test('push 使用稳定通知tag，不展示载荷正文或敏感标题',async()=>{
  const h=harness(),payload={notificationId:'n-1',kind:'changed',targetPath:'/notifications?id=n-1',tag:'n-1',title:'私有标题',body:'私有正文'}
  await h.dispatch('push',{data:{json:()=>payload}});await h.dispatch('push',{data:{json:()=>payload}})
  assert.equal(h.shows[0].tag,'notification-n-1');assert.equal(h.shows[1].tag,h.shows[0].tag)
  assert.equal(h.shows[0].title,'采集工作台');assert.equal(h.shows[0].data.url,'/notifications?id=n-1');assert(!JSON.stringify(h.shows).includes('私有'))
})
test('后端targetPath字段优先于无关url字段，坏targetPath仍安全回退',async()=>{
  const h=harness()
  await h.dispatch('push',{data:{json:()=>({notificationId:'tag-id',kind:'test',title:'推送测试',body:'打开应用查看详情',targetPath:'/notifications?id=target-id',tag:'tag-id',url:'/notifications?id=ignored-url-id'})}})
  assert.equal(h.shows[0].data.url,'/notifications?id=target-id')
  await h.dispatch('push',{data:{json:()=>({notificationId:'tag-id',targetPath:'https://other.example/',url:'/notifications?id=ignored-url-id'})}})
  assert.equal(h.shows[1].data.url,'/notifications?id=tag-id');assert.equal(h.network.length,0)
})
test('通知点击只生成同源允许路径，拒绝其他路径与非合法id',()=>{
  const h=harness(),safe=(url,id)=>h.context.safeNotificationUrl(url,id)
  assert.equal(safe('/notifications?id=n-1'),'/notifications?id=n-1')
  assert.equal(safe('/notifications/n-1'),'/notifications?id=n-1')
  assert.equal(safe('/notifications?notificationId=n-1'),'/notifications?id=n-1')
  assert.equal(safe('/notifications?id=n-1&notificationId=n-1'),'/notifications?id=n-1')
  assert.equal(safe('/notifications?id=n-1&notificationId=other'),'/notifications')
  for(const url of ['https://other.example/notifications','javascript:noop','//other.example/notifications','/\\other.example','/api/v1/notifications','/notifications?id=a&id=b','/notifications?id=bad%2Fid','/notifications#fragment','/notifications?next=/tasks','/%2fother.example']) assert.equal(safe(url),'/notifications',url)
  assert.equal(safe('//other.example','n-1'),'/notifications?id=n-1')
})
test('点击聚焦应用窗口、导航通知页，不访问API或标已读',async()=>{
  const h=harness(),actions=[]
  h.clients.matchAll=async()=>[{url:origin+'/tasks',async navigate(url){actions.push(url);return {async focus(){actions.push('focus')}}}}]
  let closed=false
  await h.dispatch('notificationclick',{notification:{data:{url:'/notifications?id=n-1'},close(){closed=true}}})
  assert(closed);assert.deepEqual(actions,[origin+'/notifications?id=n-1','focus']);assert.equal(h.network.length,0);assert.equal(h.opened.length,0)
})
test('无窗口或旧窗口导航失败时打开安全通知页',async()=>{
  const h=harness();h.clients.matchAll=async()=>[{url:origin+'/tasks',async navigate(){throw Error('closed')}}]
  await h.dispatch('notificationclick',{notification:{data:{url:'//other.example'},close(){}}})
  assert.deepEqual(h.opened,[origin+'/notifications'])
})
test('安装只precache公开精确清单，credentials omit，不自动skipWaiting',async()=>{
  const h=harness();await h.dispatch('install')
  assert.equal(h.added.length,1);assert.equal(h.added[0].url,origin+'/offline.html');assert.equal(h.added[0].credentials,'omit');assert.equal(h.messages.length,0)
  await h.dispatch('activate');assert.deepEqual(h.cacheDeletes,['page-gather-public-old'])
})
test('只有同源window用户消息允许skipWaiting',async()=>{
  const h=harness()
  for(const values of [{data:{type:'OTHER'}},{data:{type:'SKIP_WAITING'}},{data:{type:'SKIP_WAITING'},source:{type:'window',url:'https://other.example/'}}]) await h.dispatch('message',values)
  assert.equal(h.messages.length,0)
  await h.dispatch('message',{data:{type:'SKIP_WAITING'},source:{type:'window',url:origin+'/notification-settings'}})
  assert.deepEqual(h.messages,['skipWaiting'])
})
test('API/auth网络no-store，离线失败不返回shell，不缓存任何私有数据',async()=>{
  const h=harness()
  for(const path of ['/api/v1/notifications','/api/v1/auth/me','/api/v1/entities/e1','/auth/login']) {
    const result=await h.dispatch('fetch',{request:{url:origin+path,method:'GET',mode:'cors'}})
    assert.equal(result.fromNetwork,true);assert.equal(h.network.at(-1).cache,'no-store')
  }
  assert.equal(h.cacheReads.length,0);assert.equal(h.added.length,0)
  vm.runInContext('fetch = async () => { throw new Error("offline") }',h.context)
  await assert.rejects(h.dispatch('fetch',{request:{url:origin+'/api/v1/notifications',method:'GET'}}))
  assert.equal(h.cacheReads.length,0)
})
test('任意README、通知数据、hash资源的查询变体不命中缓存',async()=>{
  const h=harness()
  for(const path of ['/notifications','/README','/entities/e1/readme','/assets/app-hash.js','/manifest.webmanifest?private=1']) assert.equal(await h.dispatch('fetch',{request:{url:origin+path,method:'GET',mode:'cors'}}),undefined)
  assert.equal(h.cacheReads.length,0)
})
test('navigation network first不缓存响应，离线只有公开fallback',async()=>{
  const h=harness(),request={url:origin+'/notifications?id=n1',method:'GET',mode:'navigate'}
  assert.equal((await h.dispatch('fetch',{request})).fromNetwork,true);assert.equal(h.network[0].cache,'no-store');assert.equal(h.added.length,0)
  vm.runInContext('fetch = async () => { throw new Error("offline") }',h.context)
  assert.equal((await h.dispatch('fetch',{request})).publicOffline,true);assert.deepEqual(h.cacheReads,['/offline.html'])
  h.entries.clear();assert.equal((await h.dispatch('fetch',{request})).status,503)
})
