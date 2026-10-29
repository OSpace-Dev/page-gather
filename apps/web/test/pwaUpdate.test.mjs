import test from 'node:test'
import assert from 'node:assert/strict'
import { applyUpdateFromClick, initPwa, updateAvailable } from '../src/pwa.ts'

test('PWA注册不请求权限，不自动skipWaiting/reload；取消更新保护表单，确认后才发送message并刷新',async t=>{
  const descriptors=new Map(),listeners={},swListeners={},sent=[],order=[]
  function global(name,value){descriptors.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{configurable:true,writable:true,value})}
  const waiting={postMessage(value){sent.push(value)}}
  const registration={waiting,addEventListener(){},async update(){}}
  global('matchMedia',()=>({matches:false}));global('isSecureContext',true)
  global('window',{addEventListener(name,fn){listeners[name]=fn},confirm(){return false}})
  global('location',{reload(){order.push('reload')}})
  global('navigator',{serviceWorker:{controller:{},addEventListener(name,fn){swListeners[name]=fn},async register(path,options){assert.equal(path,'/sw.js');assert.equal(options.scope,'/');assert.equal(options.updateViaCache,'none');order.push('register');return registration}}})
  global('Notification',{requestPermission(){throw Error('禁止真实权限申请')}})
  t.after(()=>{for(const [name,descriptor] of descriptors) if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name]})
  initPwa();await Promise.resolve();await Promise.resolve()
  assert.equal(updateAvailable.value,true);assert.deepEqual(sent,[])
  swListeners.controllerchange();assert.deepEqual(order,['register'])
  applyUpdateFromClick();assert.deepEqual(sent,[])
  window.confirm=()=>true;applyUpdateFromClick();assert.deepEqual(sent,[{type:'SKIP_WAITING'}]);assert.deepEqual(order,['register'])
  swListeners.controllerchange();assert.deepEqual(order,['register','reload'])
  swListeners.controllerchange();assert.deepEqual(order,['register','reload'])
})
