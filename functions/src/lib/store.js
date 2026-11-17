// Small table-access layer so the handlers can be unit-tested with an in-memory store.
// Every function in this project talks to TablesDB through this interface only.
import { Client, Query, TablesDB } from 'node-appwrite';

export class ConflictError extends Error {
  constructor(message = 'Row already exists') {
    super(message);
    this.name = 'ConflictError';
  }
}

export const TABLES = ['buttons', 'actions', 'runs'];

export function tableIdsFromEnv(env = process.env) {
  return {
    buttons: env.TABLE_BUTTONS || 'buttons',
    actions: env.TABLE_ACTIONS || 'actions',
    runs: env.TABLE_RUNS || 'runs',
  };
}

/**
 * Store backed by Appwrite TablesDB.
 * Rows are created with no permissions: only server-side API keys can touch them.
 */
export function createAppwriteStore({ endpoint, projectId, apiKey, databaseId, tableIds }) {
  const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
  const db = new TablesDB(client);
  const t = (table) => {
    const id = tableIds[table];
    if (!id) throw new Error(`Unknown table: ${table}`);
    return id;
  };

  return {
    async get(table, id) {
      try {
        return await db.getRow({ databaseId, tableId: t(table), rowId: id });
      } catch (e) {
        if (e?.code === 404) return null;
        throw e;
      }
    },

    async create(table, id, data) {
      try {
        return await db.createRow({ databaseId, tableId: t(table), rowId: id, data, permissions: [] });
      } catch (e) {
        if (e?.code === 409) throw new ConflictError();
        throw e;
      }
    },

    async update(table, id, data) {
      return db.updateRow({ databaseId, tableId: t(table), rowId: id, data });
    },

    async delete(table, id) {
      await db.deleteRow({ databaseId, tableId: t(table), rowId: id });
    },

    /**
     * List rows matching all `where` equalities, newest first.
     * Returns { rows, total }.
     */
    async list(table, { where = {}, limit = 25, cursorAfter } = {}) {
      const queries = [Query.orderDesc('$createdAt'), Query.limit(limit)];
      for (const [key, value] of Object.entries(where)) {
        queries.push(Query.equal(key, Array.isArray(value) ? value : [value]));
      }
      if (cursorAfter) queries.push(Query.cursorAfter(cursorAfter));
      const result = await db.listRows({ databaseId, tableId: t(table), queries });
      return { rows: result.rows, total: result.total };
    },
  };
}

/** In-memory store with the same contract, for tests and local experiments. */
export function createMemoryStore(seed = {}) {
  const tables = Object.fromEntries(TABLES.map((name) => [name, new Map()]));
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const tick = () => new Date((clock += 1000)).toISOString();

  for (const [table, rows] of Object.entries(seed)) {
    for (const row of rows) {
      const ts = tick();
      tables[table].set(row.$id, { $createdAt: ts, $updatedAt: ts, ...structuredClone(row) });
    }
  }

  const tableOf = (name) => {
    const t = tables[name];
    if (!t) throw new Error(`Unknown table: ${name}`);
    return t;
  };

  return {
    tables,
    async get(table, id) {
      const row = tableOf(table).get(id);
      return row ? structuredClone(row) : null;
    },
    async create(table, id, data) {
      const t = tableOf(table);
      if (t.has(id)) throw new ConflictError();
      const ts = tick();
      const row = { ...structuredClone(data), $id: id, $createdAt: ts, $updatedAt: ts };
      t.set(id, row);
      return structuredClone(row);
    },
    async update(table, id, data) {
      const t = tableOf(table);
      const row = t.get(id);
      if (!row) {
        const err = new Error('Row not found');
        err.code = 404;
        throw err;
      }
      Object.assign(row, structuredClone(data), { $updatedAt: tick() });
      return structuredClone(row);
    },
    async delete(table, id) {
      tableOf(table).delete(id);
    },
    async list(table, { where = {}, limit = 25, cursorAfter } = {}) {
      let rows = [...tableOf(table).values()].filter((row) =>
        Object.entries(where).every(([k, v]) => (Array.isArray(v) ? v.includes(row[k]) : row[k] === v)),
      );
      rows.sort((a, b) => b.$createdAt.localeCompare(a.$createdAt));
      const total = rows.length;
      if (cursorAfter) {
        const idx = rows.findIndex((r) => r.$id === cursorAfter);
        rows = idx >= 0 ? rows.slice(idx + 1) : [];
      }
      return { rows: rows.slice(0, limit).map((r) => structuredClone(r)), total };
    },
  };
}
