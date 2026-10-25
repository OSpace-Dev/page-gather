import github from '../../plugins/github-trending/index.js';
import { hash } from '../../packages/plugin-sdk/index.js';
import { check, object } from './errors.js';

// 仅部署安装的可信插件；不接受上传、文件路径或动态 import。
export const plugins = [github.manifest];
export function configFor(pluginId, version, input) {
  check(pluginId === github.manifest.id && version === github.manifest.version, 'PLUGIN_NOT_INSTALLED', 400);
  try { return github.validateConfig(input); } catch { check(false, 'INVALID_CONFIG', 400); }
}
function schema(value, rule) {
  if (rule.type) {
    const types = Array.isArray(rule.type) ? rule.type : [rule.type];
    check(types.some(type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? object(value) : type === 'integer' ? Number.isSafeInteger(value) : typeof value === type), 'INVALID_PAYLOAD', 400);
  }
  if (Object.hasOwn(rule, 'const')) check(value === rule.const, 'INVALID_PAYLOAD', 400);
  if (rule.enum) check(rule.enum.includes(value), 'INVALID_PAYLOAD', 400);
  if (rule.minimum !== undefined) check(value >= rule.minimum, 'INVALID_PAYLOAD', 400);
  if (rule.pattern) check(new RegExp(rule.pattern).test(value), 'INVALID_PAYLOAD', 400);
  if (rule.format === 'date-time') check(typeof value === 'string' && Number.isFinite(Date.parse(value)), 'INVALID_PAYLOAD', 400);
  if (rule.format === 'date') check(/^\d{4}-\d{2}-\d{2}$/.test(value), 'INVALID_PAYLOAD', 400);
  if (object(value) && rule.properties) {
    check((rule.required ?? []).every(k => Object.hasOwn(value, k)), 'INVALID_PAYLOAD', 400);
    check(Object.keys(value).every(k => Object.hasOwn(rule.properties, k) && k !== 'checkpoint'), 'INVALID_PAYLOAD', 400);
    for (const [k, v] of Object.entries(value)) schema(v, rule.properties[k]);
  }
  if (Array.isArray(value) && rule.items) { check(value.length <= 200, 'INVALID_PAYLOAD', 400); for (const v of value) schema(v, rule.items); }
}
export function validateSubmission(submission, collection, run) {
  check(object(submission), 'INVALID_SUBMISSION', 400);
  const { payload } = submission;
  check(submission.collectionId === collection.id && submission.collectionSeq === collection.seq && payload?.collectionId === collection.id && payload?.collectionSeq === collection.seq && payload?.taskSnapshotRef === run.taskSnapshotRef, 'COLLECTION_BINDING_MISMATCH');
  check(typeof submission.payloadHash === 'string' && /^[a-f0-9]{64}$/.test(submission.payloadHash) && hash(payload) === submission.payloadHash, 'PAYLOAD_HASH_MISMATCH');
  schema(payload, github.manifest.outputSchema);
  const config = run.config;
  check(payload.scopeKey === `github-trending:daily:${config.language ?? 'all'}:${config.spokenLanguage ?? 'all'}`, 'SNAPSHOT_MISMATCH');
  check(payload.snapshot.entries.length <= config.maxRepos && payload.items.every(i => i.readme.text === null || Buffer.byteLength(i.readme.text) <= 512 * 1024), 'INVALID_PAYLOAD', 400);
  const state = {
    queue: payload.snapshot.entries.map(({ status, error, ...entry }) => entry),
    items: payload.items, observedAt: payload.observedAt, capturedDate: payload.capturedDate,
    expiresAt: Date.parse(payload.observedAt) + 86400000, errors: payload.errors,
    terminalItemFailures: payload.terminalItemFailures, blockedBatch: payload.blockedBatch,
    attempts: Object.fromEntries(payload.terminalItemFailures.map(k => [k, 2]))
  };
  check(github.validateState(state), 'INVALID_PAYLOAD', 400);
  check(payload.items.every(item => item.rank === state.queue.find(q => q.key === item.queueKey)?.rank), 'INVALID_PAYLOAD', 400);
  const expected = { ...github.snapshotResult({ collectionId: collection.id, collectionSeq: collection.seq, config }, state), taskSnapshotRef: run.taskSnapshotRef };
  check(hash(expected) === hash(payload), 'SNAPSHOT_MISMATCH');
  return payload;
}
