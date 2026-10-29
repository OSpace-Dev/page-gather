import test from 'node:test'
import assert from 'node:assert/strict'
import { currentOwnedDevice, fixedVersion, loginRedirect, notificationQueryId, notificationsClient, notificationPage, originalTarget, parseDetail, parseDevice, parseNotification, parsePushConfig } from '../src/notifications.ts'

// 合成fixture逐字段对应apps/server/README的最终P4 DTO，不接真实账号或推送服务。
const at='2026-10-29T12:00:00.000Z'
const delivery={pending:1,retry:0,sending:0,accepted:0,failed:0,skipped:0}
const notification={id:'n-contract',kind:'changed',title:'项目内容已变化',body:'合成项目短摘要',taskId:'task-contract',runId:'run-original',entityId:'entity-contract',versionId:'version-original',targetPath:'/runs?runId=run-original&entityId=entity-contract&versionId=version-original',createdAt:at,readAt:null,dedupeKey:'version:version-original',matchedRuleIds:['rule-contract'],delivery}
const readme=text=>({format:'rendered_text',status:'found',text,sourceUrl:'https://example.invalid/synthetic',truncated:false})

test('最终GET列表/详情DTO均可解析，原目标保留run+entity+version，不采用当前实体或任意targetPath',()=>{
  const item=parseNotification(notification),detail=parseDetail({notification})
  assert.equal(item.id,notification.id);assert.equal('body' in item,false);assert.equal(detail.body,notification.body);assert.deepEqual(detail.delivery,delivery)
  assert.equal(originalTarget(detail),notification.targetPath)
  assert.equal(originalTarget({...detail,targetPath:'https://other.example/'}),notification.targetPath)
  assert.equal(originalTarget({...detail,entityId:null,versionId:null}),'/runs?runId=run-original')
  assert.equal(originalTarget({...detail,versionId:null}),undefined)
})
test('Workspace固定版本选择优先原version而非currentVersion，不完整或跨run/entity不得回退',()=>{
  const original={id:'version-original',entityId:'entity-contract',runId:'run-original',readme:readme('原运行正文')}
  const latest={id:'version-current',entityId:'entity-contract',runId:'run-new',readme:readme('当前正文，不能借用')}
  const entity={id:'entity-contract',currentVersionId:latest.id,readme:latest.readme}
  const selected=fixedVersion([latest,original],notification.versionId,entity.id,notification.runId)
  assert.equal(selected.id,original.id);assert.equal(selected.readme.text,'原运行正文');assert.notEqual(selected.readme,entity.readme)
  assert.throws(()=>fixedVersion([latest],notification.versionId,entity.id,notification.runId),/不存在/)
  assert.throws(()=>fixedVersion([{...original,runId:'other-run'}],notification.versionId,entity.id,notification.runId),/格式不匹配/)
  assert.throws(()=>fixedVersion([{...original,entityId:'other-entity'}],notification.versionId,entity.id,notification.runId),/格式不匹配/)
  assert.throws(()=>fixedVersion([{...original,readme:{}}],notification.versionId,entity.id,notification.runId),/格式不匹配/)
})
test('原版本明确not_found允许显示缺失，但不读取实体当前正文',()=>{
  const original={id:'version-original',entityId:'entity-contract',runId:'run-original',readme:{format:'rendered_text',status:'not_found',text:null}}
  assert.equal(fixedVersion([original],original.id,original.entityId,original.runId).readme.text,null)
})
test('id/notificationId query统一规范化，重复冲突或数组明确报错，登录保持安全目标',()=>{
  assert.equal(notificationQueryId({}), '')
  for(const query of [{id:'n-contract'},{notificationId:'n-contract'},{id:'n-contract',notificationId:'n-contract'}]) assert.equal(notificationQueryId(query),'n-contract')
  for(const query of [{id:['n-contract']},{id:''},{notificationId:null},{id:'n-contract',notificationId:'other'},{notificationId:'bad/id'}]) assert.throws(()=>notificationQueryId(query),/格式不匹配/)
  assert.equal(loginRedirect('/notifications?notificationId=n-contract'),'/notifications?id=n-contract')
  assert.equal(loginRedirect('/notifications?id=n-contract&notificationId=other'),'/overview')
  assert.equal(loginRedirect(notification.targetPath),notification.targetPath)
})
test('最终设备DTO必须显式owned；本地id与enabled均不能代替当前session归属',()=>{
  const device=parseDevice({id:'d-contract',deviceLabel:'合成设备',enabled:true,createdAt:at,updatedAt:at,owned:false})
  assert.equal(device.owned,false);assert.throws(()=>currentOwnedDevice([device],device.id),/重新登记/)
  assert.throws(()=>parseDevice({...device,owned:undefined}),/格式不匹配/)
  assert.equal(currentOwnedDevice([{...device,owned:true}],device.id,true).id,device.id)
  assert.throws(()=>currentOwnedDevice([{...device,owned:true,enabled:false}],device.id,true),/停用/)
  assert.throws(()=>currentOwnedDevice([{...device,owned:true}],'different-local-id'),/重新登记/)
})
test('disabled或缺VAPID保持站内DTO可读，configured=false强制publicKey=null',()=>{
  for(const config of [{configured:false,enabled:false,publicKey:null,reason:'PUSH_DISABLED'},{configured:false,enabled:true,publicKey:null,reason:'PUSH_KEY_FILE_MISSING'}]) assert.equal(parsePushConfig(config).configured,false)
  assert.throws(()=>parsePushConfig({configured:false,enabled:true,publicKey:'unexpected',reason:'PUSH_KEY_FILE_MISSING'}),/格式不匹配/)
  assert.equal(parseDetail({notification}).id,notification.id)
})
test('实际分页/全部已读DTO不能缺字段：read-all严格解析count后再刷新事实',async t=>{
  assert.equal(notificationPage({items:[notification],nextCursor:null},parseNotification).items[0].id,notification.id)
  assert.throws(()=>notificationPage({items:[notification]},parseNotification),/格式不匹配/)
  const previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous})
  globalThis.fetch=async(url,options)=>{assert.equal(url,'/api/v1/notifications/read-all');assert.equal(options.cache,'no-store');assert.deepEqual(JSON.parse(options.body),{});return new Response(JSON.stringify({count:0}))}
  assert.equal(await notificationsClient.readAll(),0)
  globalThis.fetch=async()=>new Response(JSON.stringify({ok:true}))
  await assert.rejects(notificationsClient.readAll(),/格式不匹配/)
})
