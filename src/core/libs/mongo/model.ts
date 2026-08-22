import { ObjectId } from 'mongodb';
import type {
  Collection,
  Filter,
  OptionalUnlessRequiredId,
  Sort,
  UpdateFilter,
  WithId as MongoWithId,
} from 'mongodb';
import { getDb } from './connection.js';
import {
  applyDefaults,
  normalizeSchema,
  uniqueFields,
  validate,
  type FieldErrors,
  type SchemaDefinition,
} from './schema.js';

export interface Timestamps {
  createdAt: Date;
  updatedAt: Date;
}

/** A document without `_id`: user fields plus automatic timestamps. */
export type ModelDoc<T> = T & Timestamps;
/** A document as stored/returned by MongoDB. */
export type WithId<T> = MongoWithId<ModelDoc<T>>;
/** Fields the user can provide when creating a document. */
export type ModelInput<T> = Omit<T, keyof Timestamps>;

export interface PaginateOptions {
  page?: number;
  limit?: number;
  sort?: Sort;
}

export interface PaginateResult<T> {
  data: WithId<T>[];
  total: number;
  page: number;
  pages: number;
  limit: number;
}

/** Thrown when document data fails schema validation. */
export class MongoModelError extends Error {
  readonly fields: FieldErrors;

  constructor(fields: FieldErrors) {
    super('Mongo document validation failed');
    this.name = 'MongoModelError';
    this.fields = fields;
  }
}

function pluralize(name: string): string {
  return name.endsWith('y') ? `${name.slice(0, -1)}ies` : `${name}s`;
}

/** A typed, schema-validated wrapper around a MongoDB collection. */
export class Model<T extends Record<string, unknown>> {
  readonly name: string;
  readonly collectionName: string;
  readonly schema: Record<string, import('./schema.js').SchemaFieldOptions>;

  constructor(name: string, schema: SchemaDefinition, collectionName?: string) {
    this.name = name;
    this.schema = normalizeSchema(schema);
    this.collectionName = collectionName ?? pluralize(name);
  }

  /** Lazily resolved collection from the active connection. */
  get collection(): Collection<ModelDoc<T>> {
    return getDb().collection<ModelDoc<T>>(this.collectionName);
  }

  /** Validated insert with automatic timestamps. */
  async create(data: ModelInput<T>): Promise<WithId<T>> {
    const input = applyDefaults(data as Record<string, unknown>, this.schema);
    const errors = validate(input, this.schema);
    if (errors) throw new MongoModelError(errors);
    const now = new Date();
    const doc = { ...input, createdAt: now, updatedAt: now } as ModelDoc<T>;
    const { insertedId } = await this.collection.insertOne(
      doc as OptionalUnlessRequiredId<ModelDoc<T>>,
    );
    return { ...doc, _id: insertedId } as unknown as WithId<T>;
  }

  /** Insert many documents, validating each. */
  async createMany(data: ModelInput<T>[]): Promise<WithId<T>[]> {
    const now = new Date();
    const docs: ModelDoc<T>[] = [];
    for (const item of data) {
      const input = applyDefaults(item as Record<string, unknown>, this.schema);
      const errors = validate(input, this.schema);
      if (errors) throw new MongoModelError(errors);
      docs.push({ ...input, createdAt: now, updatedAt: now } as ModelDoc<T>);
    }
    const result = await this.collection.insertMany(
      docs as OptionalUnlessRequiredId<ModelDoc<T>>[],
    );
    return docs.map((doc, i) => ({ ...doc, _id: result.insertedIds[i] }) as unknown as WithId<T>);
  }

  async find(
    query: Filter<ModelDoc<T>> = {},
    options: { sort?: Sort; limit?: number; skip?: number } = {},
  ): Promise<WithId<T>[]> {
    return this.collection.find(query, options).toArray() as Promise<WithId<T>[]>;
  }

  async findOne(query: Filter<ModelDoc<T>>): Promise<WithId<T> | null> {
    return this.collection.findOne(query) as Promise<WithId<T> | null>;
  }

  async findById(id: string | ObjectId): Promise<WithId<T> | null> {
    if (!ObjectId.isValid(id)) return null;
    return this.collection.findOne({ _id: new ObjectId(id) } as Filter<ModelDoc<T>>) as Promise<
      WithId<T> | null
    >;
  }

  async exists(query: Filter<ModelDoc<T>>): Promise<boolean> {
    return (await this.collection.countDocuments(query, { limit: 1 })) > 0;
  }

  /** Validated update. Missing fields are merged, present ones re-validated. */
  async updateById(id: string | ObjectId, data: Partial<ModelInput<T>>): Promise<WithId<T> | null> {
    if (!ObjectId.isValid(id)) return null;
    const existing = await this.findById(id);
    if (!existing) return null;
    const merged = applyDefaults({ ...existing, ...data } as Record<string, unknown>, this.schema);
    const errors = validate(merged, this.schema);
    if (errors) throw new MongoModelError(errors);
    const updated = { ...existing, ...data, updatedAt: new Date() };
    const { _id: _ignored, createdAt: _created, ...set } = updated;
    await this.collection.updateOne(
      { _id: existing._id } as Filter<ModelDoc<T>>,
      { $set: set } as unknown as UpdateFilter<ModelDoc<T>>,
    );
    return updated as unknown as WithId<T>;
  }

  async updateOne(query: Filter<ModelDoc<T>>, update: Partial<ModelInput<T>>): Promise<WithId<T> | null> {
    const existing = await this.collection.findOne(query);
    if (!existing) return null;
    const merged = applyDefaults({ ...existing, ...update } as Record<string, unknown>, this.schema);
    const errors = validate(merged, this.schema);
    if (errors) throw new MongoModelError(errors);
    const updated = { ...existing, ...update, updatedAt: new Date() };
    const { _id: _ignored, createdAt: _created, ...set } = updated;
    await this.collection.updateOne(
      { _id: existing._id } as Filter<ModelDoc<T>>,
      { $set: set } as unknown as UpdateFilter<ModelDoc<T>>,
    );
    return updated as unknown as WithId<T>;
  }

  async deleteById(id: string | ObjectId): Promise<WithId<T> | null> {
    if (!ObjectId.isValid(id)) return null;
    const doc = await this.findById(id);
    if (!doc) return null;
    await this.collection.deleteOne({ _id: doc._id } as Filter<ModelDoc<T>>);
    return doc;
  }

  async deleteOne(query: Filter<ModelDoc<T>>): Promise<WithId<T> | null> {
    const doc = await this.collection.findOne(query);
    if (!doc) return null;
    await this.collection.deleteOne({ _id: doc._id } as Filter<ModelDoc<T>>);
    return doc;
  }

  async count(query: Filter<ModelDoc<T>> = {}): Promise<number> {
    return this.collection.countDocuments(query);
  }

  async paginate(query: Filter<ModelDoc<T>> = {}, options: PaginateOptions = {}): Promise<PaginateResult<T>> {
    const page = Math.max(1, options.page ?? 1);
    const limit = Math.min(100, Math.max(1, options.limit ?? 20));
    const [data, total] = await Promise.all([
      this.collection.find(query, { sort: options.sort, skip: (page - 1) * limit, limit }).toArray(),
      this.collection.countDocuments(query),
    ]);
    return { data: data as WithId<T>[], total, page, pages: Math.ceil(total / limit), limit };
  }

  /** Creates unique indexes declared in the schema. Call once after connecting. */
  async buildIndexes(): Promise<void> {
    const unique = uniqueFields(this.schema);
    if (unique.length === 0) return;
    await this.collection.createIndexes(unique.map((field) => ({ key: { [field]: 1 }, unique: true })));
  }
}

export function model<T extends Record<string, unknown>>(
  name: string,
  schema: SchemaDefinition,
  collectionName?: string,
): Model<T> {
  return new Model<T>(name, schema, collectionName);
}