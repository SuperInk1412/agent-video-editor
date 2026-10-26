// The deliberately small JSON Schema subset used by our own public contracts.
// This is not a general-purpose JSON Schema implementation.
import { fault } from './errors.js';

export function validateContract(value, schema, root = schema, at = '') {
  const fail = (message) => { throw fault('INVALID_ARGUMENT', `${at || 'input'}: ${message}`); };
  if (schema.$ref) {
    const target = schema.$ref.split('/').slice(1).reduce((item, key) => item?.[key], root);
    if (!target) fail('invalid schema reference');
    return validateContract(value, target, root, at);
  }
  const variants = schema.oneOf || schema.anyOf;
  if (variants) {
    const matching = variants.filter((variant) => { try { validateContract(value, variant, root, at); return true; } catch { return false; } });
    if (!matching.length || schema.oneOf && matching.length !== 1) fail('does not match a supported variant');
  }
  if (schema.const !== undefined && value !== schema.const) fail(`must equal ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) fail(`must be one of ${schema.enum.join(', ')}`);
  const types = schema.type ? [schema.type].flat() : [];
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (types.length && !types.includes(type) && !(type === 'number' && types.includes('integer') && Number.isInteger(value))) fail(`must be ${types.join(' or ')}`);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum || schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) fail('number outside supported range');
  }
  if (typeof value === 'string' && (schema.minLength !== undefined && value.length < schema.minLength || schema.maxLength !== undefined && value.length > schema.maxLength)) fail('string length outside supported range');
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) fail('array size outside supported range');
    if (schema.items) value.forEach((entry, i) => validateContract(entry, schema.items, root, `${at}[${i}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
    for (const [key, entry] of Object.entries(value)) {
      if (schema.properties?.[key]) validateContract(entry, schema.properties[key], root, at ? `${at}.${key}` : key);
      else if (schema.additionalProperties === false) fail(`unknown field ${key}`);
    }
  }
  return value;
}
