/**
 * Provider-compatible JSON Schema subset check.
 *
 * DSH's structured-output boundary (`@deepseek-ai/dsh-tools`
 * `assertObjectJsonSchema`) rejects keywords outside a closed subset before an
 * agent activation starts. A plugin may only import Node built-ins and its own
 * dependencies, so this module mirrors that validator instead of importing the
 * Host package. Every model-facing schema is checked here at plugin boot, and
 * again immediately before the corresponding activation.
 *
 * Keep the subset and messages in sync with
 * `@deepseek-ai/dsh-tools/lib/shared-DTdn5dXO.js` (`checkSchemaNode`).
 */

const CONSTRAINT_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
]);
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples']);
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const ONE_OF_SIBLING_KEYWORDS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const'];

export class JsonSchemaSubsetError extends Error {
  constructor(violations) {
    super(`unsupported JSON schema: ${violations.join('; ')}`);
    this.name = 'JsonSchemaSubsetError';
    this.code = 'UNSUPPORTED_SCHEMA';
    this.violations = violations;
  }
}

export class ModelSchemaError extends Error {
  constructor(role, violations, options = {}) {
    super(`model schema '${role}' is rejected by the DSH structured-output subset: ${violations.join('; ')}`, options);
    this.name = 'ModelSchemaError';
    this.code = 'UNSUPPORTED_MODEL_SCHEMA';
    this.role = role;
    this.violations = violations;
  }
}

function isRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function isArray(value) {
  return Array.isArray(value);
}

function isJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index) || !isJsonValue(value[index], seen)) return false;
      }
      return true;
    }
    if (!isRecord(value)) return false;
    for (const key of Object.keys(value)) if (!isJsonValue(value[key], seen)) return false;
    return true;
  } finally {
    seen.delete(value);
  }
}

function scalarMatches(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0);
    case 'integer': return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && !Object.is(value, -0);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return false;
  }
}

/**
 * Collect every violation in a raw schema tree.
 * @param {unknown} root
 * @param {string} rootPath
 * @param {string[]} violations
 */
function checkSchemaNode(root, rootPath, violations) {
  const tasks = [{ kind: 'enter', node: root, path: rootPath }];
  const seen = new Set();
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) {
    if (task.kind === 'leave') {
      seen.delete(task.node);
      continue;
    }
    if (task.kind === 'one-of-tail') {
      for (const key of ONE_OF_SIBLING_KEYWORDS) {
        if (Object.hasOwn(task.node, key)) violations.push(`${task.path}.${key} is not supported beside oneOf`);
      }
      continue;
    }
    if (task.kind === 'object-tail') {
      const node = task.node;
      if (Object.hasOwn(node, 'required')) {
        const required = node.required;
        if (!isArray(required) || required.some((entry) => typeof entry !== 'string')) {
          violations.push(`${task.path}.required must be an array of strings`);
        } else {
          const properties = isRecord(task.properties) ? task.properties : {};
          for (const key of required) {
            if (!Object.hasOwn(properties, key)) violations.push(`${task.path}.required names "${key}" which is not in properties`);
          }
        }
      }
      if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
        violations.push(`${task.path}.additionalProperties must be a boolean`);
      }
      continue;
    }

    const { node, path } = task;
    if (!isRecord(node)) {
      violations.push(`${path} must be a schema object`);
      continue;
    }
    if (seen.has(node)) {
      violations.push(`${path} is circular`);
      continue;
    }
    seen.add(node);
    tasks.push({ kind: 'leave', node });

    for (const key of Object.keys(node)) {
      if (CONSTRAINT_KEYWORDS.has(key)) continue;
      if (ANNOTATION_KEYWORDS.has(key)) {
        if (!isJsonValue(node[key])) violations.push(`${path}.${key} annotation must be lossless JSON data`);
        continue;
      }
      violations.push(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`);
    }
    if (Object.hasOwn(node, 'description') && typeof node.description !== 'string') violations.push(`${path}.description must be a string`);
    if (Object.hasOwn(node, 'title') && typeof node.title !== 'string') violations.push(`${path}.title must be a string`);

    const hasType = Object.hasOwn(node, 'type');
    const hasOneOf = Object.hasOwn(node, 'oneOf');
    if (hasType && hasOneOf) {
      violations.push(`${path} cannot declare both type and oneOf`);
      continue;
    }
    if (!hasType && !hasOneOf) {
      for (const key of ONE_OF_SIBLING_KEYWORDS) {
        if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`);
      }
      continue;
    }
    if (hasOneOf) {
      const oneOf = node.oneOf;
      tasks.push({ kind: 'one-of-tail', node, path });
      if (!isArray(oneOf) || oneOf.length < 2) violations.push(`${path}.oneOf must be an array of at least two schemas`);
      else for (let index = oneOf.length - 1; index >= 0; index -= 1) tasks.push({ kind: 'enter', node: oneOf[index], path: `${path}.oneOf[${index}]` });
      continue;
    }

    const type = node.type;
    if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
      violations.push(Array.isArray(type)
        ? `${path}.type must be a single type string (type arrays are not supported)`
        : `${path}.type must be one of ${SCHEMA_TYPES.join('/')}`);
      continue;
    }

    for (const [key, allowedTypes] of Object.entries({
      properties: ['object'],
      required: ['object'],
      additionalProperties: ['object'],
      items: ['array'],
      enum: ['string', 'number', 'integer', 'boolean', 'null'],
      const: ['string', 'number', 'integer', 'boolean', 'null'],
    })) {
      if (Object.hasOwn(node, key) && !allowedTypes.includes(type)) violations.push(`${path}.${key} is not supported on type "${type}"`);
    }

    switch (type) {
      case 'object': {
        const properties = Object.hasOwn(node, 'properties') ? node.properties : undefined;
        tasks.push({ kind: 'object-tail', node, path, properties });
        if (Object.hasOwn(node, 'properties')) {
          if (!isRecord(properties)) violations.push(`${path}.properties must be an object of schemas`);
          else {
            const entries = Object.entries(properties);
            for (let index = entries.length - 1; index >= 0; index -= 1) {
              const [key, child] = entries[index];
              tasks.push({ kind: 'enter', node: child, path: `${path}.properties.${key}` });
            }
          }
        }
        break;
      }
      case 'array':
        if (Object.hasOwn(node, 'items')) tasks.push({ kind: 'enter', node: node.items, path: `${path}.items` });
        break;
      case 'string':
      case 'number':
      case 'integer':
      case 'boolean':
      case 'null': {
        const hasEnum = Object.hasOwn(node, 'enum');
        const allowed = hasEnum ? node.enum : undefined;
        const enumValid = isArray(allowed) && allowed.length > 0 && allowed.every((entry) => scalarMatches(type, entry));
        if (hasEnum && !enumValid) violations.push(`${path}.enum must be a non-empty array of ${type} values`);
        const hasConst = Object.hasOwn(node, 'const');
        if (hasConst) {
          if (!scalarMatches(type, node.const)) violations.push(`${path}.const must be a ${type} value`);
          else if (enumValid && !allowed.includes(node.const)) violations.push(`${path}.const must be one of ${path}.enum when both are declared`);
        }
        break;
      }
      default:
        break;
    }
  }
}

/**
 * Assert the exact structured-output subset plus an object root.
 * @param {unknown} schema
 */
export function assertObjectJsonSchema(schema) {
  const violations = [];
  checkSchemaNode(schema, 'schema', violations);
  if (violations.length === 0 && (!isRecord(schema) || !Object.hasOwn(schema, 'type') || schema.type !== 'object')) {
    violations.push('schema.type must be "object" (structured output is object-rooted)');
  }
  if (violations.length > 0) throw new JsonSchemaSubsetError(violations);
}

/**
 * Assert one role schema and name the role in the failure.
 * @param {unknown} schema
 * @param {string} role
 */
export function assertModelSchema(schema, role = 'model') {
  try {
    assertObjectJsonSchema(schema);
  } catch (error) {
    if (error instanceof JsonSchemaSubsetError) throw new ModelSchemaError(role, error.violations, { cause: error });
    throw error;
  }
}
