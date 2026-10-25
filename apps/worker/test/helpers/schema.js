import assert from 'node:assert/strict';

// 仅测试使用的受限 JSON Schema checker；遇到未支持关键字直接失败，避免静默漏验。
const supported = new Set(['type', 'required', 'properties', 'items', 'enum', 'const', 'minimum', 'maximum', 'pattern', 'format', 'additionalProperties', 'description', 'default']);
export function checkSchema(schema, value, path = '$') {
  for (const key of Object.keys(schema)) assert.ok(supported.has(key), `unsupported schema keyword: ${key}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'integer' ? Number.isSafeInteger(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : typeof value === type;
    assert.ok(types.some(matches), `${path}: type`);
  }
  if (Object.hasOwn(schema, 'const')) assert.deepEqual(value, schema.const, `${path}: const`);
  if (schema.enum) assert.ok(schema.enum.includes(value), `${path}: enum`);
  if (schema.minimum !== undefined) assert.ok(value >= schema.minimum, `${path}: minimum`);
  if (schema.maximum !== undefined) assert.ok(value <= schema.maximum, `${path}: maximum`);
  if (schema.pattern) assert.match(value, new RegExp(schema.pattern), `${path}: pattern`);
  if (schema.format) {
    assert.ok(['date-time', 'date', 'uri'].includes(schema.format), 'unsupported format');
    if (schema.format === 'uri') assert.doesNotThrow(() => new URL(value), `${path}: uri`);
    else assert.ok(Number.isFinite(Date.parse(value)) && (schema.format === 'date' ? /^\d{4}-\d{2}-\d{2}$/.test(value) : /^\d{4}-\d{2}-\d{2}T/.test(value)), `${path}: ${schema.format}`);
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `${path}.${key}: required`);
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties ?? {}, key)) checkSchema(schema.properties[key], child, `${path}.${key}`);
      else assert.notEqual(schema.additionalProperties, false, `${path}.${key}: additionalProperties`);
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((child, i) => checkSchema(schema.items, child, `${path}[${i}]`));
}
