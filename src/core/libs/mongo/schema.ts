import { ObjectId } from 'mongodb';

export type SchemaType = 'string' | 'number' | 'boolean' | 'date' | 'objectid' | 'object' | 'array';

export interface SchemaFieldOptions {
  type: SchemaType;
  /** Field is required on create. */
  required?: boolean;
  /** Default applied on create when the field is missing. */
  default?: unknown;
  /** Creates a unique index during `buildIndexes()`. */
  unique?: boolean;
  /** Whitelist of allowed values. */
  enum?: unknown[];
  /** Number fields: minimum value. */
  min?: number;
  /** Number fields: maximum value. */
  max?: number;
  /** String fields: minimum length. */
  minLength?: number;
  /** String fields: maximum length. */
  maxLength?: number;
  /** String fields: regex the value must match. */
  match?: RegExp;
  /** Array fields: element type to validate against. */
  items?: SchemaType;
  /** If `true`, never returned by queries. */
  hidden?: boolean;
}

export type SchemaField = SchemaType | SchemaFieldOptions;

export type SchemaDefinition = Record<string, SchemaField>;

export type FieldErrors = Record<string, string>;

function normalize(field: SchemaField): SchemaFieldOptions {
  return typeof field === 'string' ? { type: field } : field;
}

/** True when `value` is neither `undefined` nor `null`. */
function present(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function isType(value: unknown, type: SchemaType): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'date':
      return value instanceof Date || typeof value === 'string' || typeof value === 'number';
    case 'objectid':
      return value instanceof ObjectId || ObjectId.isValid(value as string);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
  }
}

/** Validates `data` against the schema. Returns `null` when valid, else per-field errors. */
export function validate(data: Record<string, unknown>, definition: SchemaDefinition): FieldErrors | null {
  const errors: FieldErrors = {};
  for (const [key, rawField] of Object.entries(definition)) {
    const field = normalize(rawField);
    const value = data[key];
    if (!present(value)) {
      if (field.required) errors[key] = `'${key}' is required`;
      continue;
    }
    if (!isType(value, field.type)) {
      errors[key] = `'${key}' must be of type ${field.type}`;
      continue;
    }
    if (field.enum && !field.enum.includes(value)) {
      errors[key] = `'${key}' must be one of ${field.enum.map(String).join(', ')}`;
      continue;
    }
    if (field.type === 'number') {
      if (field.min !== undefined && (value as number) < field.min) {
        errors[key] = `'${key}' must be >= ${field.min}`;
      }
      if (field.max !== undefined && (value as number) > field.max) {
        errors[key] = `'${key}' must be <= ${field.max}`;
      }
    }
    if (field.type === 'string') {
      const str = value as string;
      if (field.minLength !== undefined && str.length < field.minLength) {
        errors[key] = `'${key}' must be at least ${field.minLength} characters`;
      }
      if (field.maxLength !== undefined && str.length > field.maxLength) {
        errors[key] = `'${key}' must be at most ${field.maxLength} characters`;
      }
      if (field.match && !field.match.test(str)) {
        errors[key] = `'${key}' does not match the required pattern`;
      }
    }
    if (field.type === 'array' && field.items) {
      const list = value as unknown[];
      if (list.some((item) => !isType(item, field.items!))) {
        errors[key] = `'${key}' must only contain values of type ${field.items}`;
      }
    }
  }
  return Object.keys(errors).length > 0 ? errors : null;
}

/** Applies schema defaults to `data` for missing fields. */
export function applyDefaults(data: Record<string, unknown>, definition: SchemaDefinition): Record<string, unknown> {
  const out = { ...data };
  for (const [key, rawField] of Object.entries(definition)) {
    const field = normalize(rawField);
    if (field.default !== undefined && !present(out[key])) {
      out[key] = typeof field.default === 'function' ? (field.default as () => unknown)() : field.default;
    }
  }
  return out;
}

/** Collects fields marked `unique` so indexes can be built. */
export function uniqueFields(definition: SchemaDefinition): string[] {
  return Object.entries(definition)
    .filter(([, raw]) => normalize(raw).unique)
    .map(([key]) => key);
}

export function normalizeSchema(definition: SchemaDefinition): Record<string, SchemaFieldOptions> {
  const out: Record<string, SchemaFieldOptions> = {};
  for (const [key, field] of Object.entries(definition)) out[key] = normalize(field);
  return out;
}