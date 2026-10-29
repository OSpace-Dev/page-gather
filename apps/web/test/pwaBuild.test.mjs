import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { publicShell } from '../pwaBuild.mjs'
const source=await readFile(new URL('../public/sw.js',import.meta.url),'utf8')
test('构建生成精确公开precache/content版本，排除API/私有文件、SW自身与非hash资源',async t=>{
  const root=await mkdtemp(join(tmpdir(),'page-gather-pwa-'));t.after(()=>rm(root,{recursive:true,force:true}))
  const files=['index.html','offline.html','manifest.webmanifest','icons/icon-192.png','icons/icon-512.png','assets/app-AbCd1234.js','assets/app-AbCd1234.css','assets/private.txt','assets/not-hashed.js','api/v1/notifications.json','README.txt']
  for(const path of files) {await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),'synthetic public shell')}
  const plugin=publicShell();plugin.configResolved({root,build:{outDir:'.'}})
  plugin.generateBundle({}, {'assets/app-AbCd1234.js':{},'assets/app-AbCd1234.css':{}})
  await writeFile(join(root,'sw.js'),source);await plugin.closeBundle()
  const result=await readFile(join(root,'sw.js'),'utf8'),handlers={},added=[]
  const context=vm.createContext({URL,Request,caches:{async open(){return {async addAll(requests){added.push(...requests)}}}},self:{location:{origin:'https://app.example'},addEventListener(name,fn){handlers[name]=fn}}})
  vm.runInContext(result,context)
  const pending=[];handlers.install({waitUntil:p=>pending.push(p)});await Promise.all(pending)
  const expected=files.filter(p=>!['assets/private.txt','assets/not-hashed.js','api/v1/notifications.json','README.txt'].includes(p)).map(p=>'/'+p).sort()
  assert.deepEqual(added.map(r=>new URL(r.url).pathname).sort(),expected);assert(added.every(r=>r.credentials==='omit'))
  const version=result.match(/const VERSION = '([a-f0-9]+)'/)[1]
  await writeFile(join(root,'assets/app-AbCd1234.js'),'changed synthetic shell');await writeFile(join(root,'sw.js'),source);await plugin.closeBundle()
  assert.notEqual((await readFile(join(root,'sw.js'),'utf8')).match(/const VERSION = '([a-f0-9]+)'/)[1],version)
  // 生成后SW只读取白名单hash资源，不把查询变体或README当公开shell。
  const fetches=[],reads=[]
  vm.runInContext("fetch = async request => ({network:true})",context)
  context.caches.open=async()=>({async match(path){reads.push(path);return {publicAsset:true}}})
  let response
  handlers.fetch({request:{url:'https://app.example/assets/app-AbCd1234.js',method:'GET',mode:'cors'},respondWith:p=>response=p})
  assert.equal((await response).publicAsset,true);assert.deepEqual(reads,['/assets/app-AbCd1234.js'])
  response=undefined
  handlers.fetch({request:{url:'https://app.example/assets/app-AbCd1234.js?private=1',method:'GET',mode:'cors'},respondWith:p=>response=p})
  assert.equal(response,undefined);assert.equal(fetches.length,0)
})
test('manifest包含稳定根scope/id和真实192/512 PNG，不用SVG伪装',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../public/manifest.webmanifest',import.meta.url),'utf8'))
  assert.equal(manifest.id,'/');assert.equal(manifest.scope,'/');assert.equal(manifest.start_url,'/notifications');assert.equal(manifest.display,'standalone');assert(manifest.name)
  for(const size of [192,512]) {
    const icon=manifest.icons.find(x=>x.sizes===`${size}x${size}`);assert.equal(icon.type,'image/png')
    const png=await readFile(new URL('../public'+icon.src,import.meta.url))
    assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');assert.equal(png.readUInt32BE(16),size);assert.equal(png.readUInt32BE(20),size)
  }
})
