import { readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonCheckpointStore, hash } from '../../../packages/plugin-sdk/index.js';

const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value);
// SDK写检查点与心跳读检查点共享单写者队列，避免Windows读取句柄与原子rename竞争。
class SerializedCheckpointStore extends JsonCheckpointStore {
  io = Promise.resolve();
  exclusive(operation) { const next = this.io.then(operation); this.io = next.catch(() => {}); return next; }
  load(runId,collectionId) { return this.exclusive(() => super.load(runId,collectionId)); }
  save(runId,collectionId,document) { return this.exclusive(() => super.save(runId,collectionId,document)); }
}
// 与 SDK checkpoint 分开原子保存；不写认证 token，也不删除 SDK 收据/水位。
export class DeliverySpool {
  constructor(root) { this.store = new SerializedCheckpointStore({ root }); }
  async save(record) {
    const previous = await this.store.load(record.run.id,'pending-delivery');
    if (previous?.outcomeIntent && hash(previous.outcomeIntent) !== hash(record.outcomeIntent ?? null)) throw new Error('OUTCOME_INTENT_IMMUTABLE');
    await this.store.save(record.run.id, 'pending-delivery', record);
  }
  async loadClaimTicket() {
    const ticket = await this.store.load('worker-control','claim-ticket');
    if (ticket && (!validId(ticket.requestKey) || typeof ticket.workerId !== 'string')) throw new Error('INVALID_CLAIM_TICKET');
    return ticket;
  }
  async createClaimTicket(workerId) {
    const existing = await this.loadClaimTicket();
    if (existing) { if (existing.workerId !== workerId) throw new Error('CLAIM_WORKER_MISMATCH'); return existing; }
    const ticket = { workerId,requestKey:randomUUID() };
    await this.store.save('worker-control','claim-ticket',ticket); return ticket;
  }
  async clearClaimTicket() { await this.store.save('worker-control','claim-ticket',null); }
  async pending() {
    // directory 逐级校验宿主配置路径，拒绝 symlink/junction。
    await this.store.directory('spool-check');
    const result = [];
    for (const entry of await readdir(this.store.root, { withFileTypes: true })) {
      if (!validId(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      if ((await lstat(join(this.store.root, entry.name))).isSymbolicLink()) continue;
      const record = await this.store.load(entry.name, 'pending-delivery');
      if (!record || record.delivered) continue;
      if (record.run?.id !== entry.name || !validId(record.collection?.collectionId) && record.collection !== null) throw new Error('INVALID_DELIVERY_METADATA');
      result.push(record);
    }
    return result;
  }
}
