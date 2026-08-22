import { MongoClient, type Db, type MongoClientOptions } from 'mongodb';

export interface MongoConfig {
  uri: string;
  dbName: string;
  options?: MongoClientOptions;
}

let client: MongoClient | null = null;
let db: Db | null = null;

/** Connect to MongoDB once. Re-uses the existing connection on subsequent calls. */
export async function connectMongo(config: MongoConfig): Promise<Db> {
  if (db) return db;
  const { uri, dbName, options } = config;
  client = new MongoClient(uri, options ?? {});
  await client.connect();
  db = client.db(dbName);
  return db;
}

/** Lazily get the active `Db`. Throws if not connected yet. */
export function getDb(): Db {
  if (!db) throw new Error('MongoDB is not connected. Call `connectMongo()` first.');
  return db;
}

/** Lazily get the underlying `MongoClient`. Throws if not connected yet. */
export function getClient(): MongoClient {
  if (!client) throw new Error('MongoDB is not connected. Call `connectMongo()` first.');
  return client;
}

/** Close the connection and reset state. */
export async function disconnectMongo(): Promise<void> {
  await client?.close();
  client = null;
  db = null;
}

/** Is there an active connection? */
export function isConnected(): boolean {
  return db !== null && client !== null;
}