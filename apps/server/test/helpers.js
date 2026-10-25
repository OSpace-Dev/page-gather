import { randomUUID } from 'node:crypto';
import github from '../../../plugins/github-trending/index.js';
import { contentHash } from '../../../plugins/github-trending/index.js';
import { hash } from '../../../packages/plugin-sdk/index.js';
export const workerId = 'worker-main';
export function credentials(claim) { return { workerId, ...claim.lease }; }
export function register(store, claim) { return store.register(claim.run.id, { ...credentials(claim), registrationKey:randomUUID() }); }
export function submission(run, c, { text = 'README 内容 <script>仅文本</script>', partial = false, empty = false, rank = 1 } = {}) {
  const observedAt = '2026-06-01T10:00:00.000Z';
  const item = { queueKey:'example/repo',sourceKey:'example/repo',sourceUrl:'https://github.com/example/repo',rank,observedAt,readme:{ status:'found',format:'rendered_text',text,sourceUrl:'https://github.com/example/repo#readme-ov-file',sourceKind:'rendered_page',fileSourceUrl:null,truncated:null } };
  item.contentHash = contentHash(item);
  const state = { observedAt,capturedDate:'2026-06-01',queue:empty ? [] : [{ key:item.queueKey,url:item.sourceUrl,rank:1,description:null,language:null,stars:null,dailyChange:null }],items:empty ? [] : [item],errors:partial ? [{ itemKey:'trending',code:'READ_FAILED' }] : [],terminalItemFailures:[],blockedBatch:null };
  const payload = { ...github.snapshotResult({ collectionId:c.collectionId,collectionSeq:c.collectionSeq,config:run.config },state),taskSnapshotRef:c.taskSnapshotRef };
  return { submissionId:randomUUID(),collectionId:c.collectionId,collectionSeq:c.collectionSeq,payloadHash:hash(payload),payload };
}
export function start(store, taskId = store.list('tasks').items[0].id) {
  const run = store.createRun(taskId, randomUUID());
  const claim = store.claim({ workerId,requestKey:randomUUID() });
  if (claim?.run.id !== run.id) throw new Error('CLAIM_EXPECTED');
  return claim;
}
export function ingest(store, claim, s) {
  const body = { ...credentials(claim),submission:s };
  store.seal(claim.run.id,s.collectionId,body);
  return store.submit(claim.run.id,body).receipt;
}
