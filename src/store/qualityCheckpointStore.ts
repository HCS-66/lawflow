import { getCurrentSessionUser } from './authStore';
import { QUALITY_REVISION, type ModelReply } from '../recognition/qualityProtocol';

const DB = 'LawFlow_Quality_Evidence_v1';
export interface QualityCheckpointStore {
  read(key: string): Promise<ModelReply | undefined>;
  write(key: string, reply: ModelReply): Promise<void>;
  saveDelivery(value: unknown): Promise<void>;
  loadDelivery(): Promise<unknown | undefined>;
}
export function createQualityCheckpointStore(caseId: string, documentId: string, forceFresh: boolean): QualityCheckpointStore {
  const user = getCurrentSessionUser()?.id || 'DEFAULT_USER';
  const scope = JSON.stringify([user, caseId, documentId, QUALITY_REVISION]);
  const run = crypto.randomUUID();
  async function access(mode: IDBTransactionMode, key: string, value?: unknown): Promise<any> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('evidence', { keyPath: 'id' });
      request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('evidence', mode), store = tx.objectStore('evidence');
        const id = `${scope}:${key}`; let read: any;
        tx.oncomplete = () => resolve(read); tx.onerror = tx.onabort = () => reject(tx.error || new Error('原文证据保存失败'));
        if (mode === 'readonly') { const req = store.get(id); req.onsuccess = () => { read = req.result; }; }
        else {
          const record = { id, scope, user, caseId, documentId, revision: QUALITY_REVISION, run, savedAt: Date.now(), value };
          store.put(record);
          // Immutable attempt alongside the resumable pointer, including a fresh run.
          store.put({ ...record, id: `${id}:run:${run}:${crypto.randomUUID()}` });
        }
      });
    } finally { db.close(); }
  }
  return {
    read: async key => {
      if (forceFresh) return undefined;
      const record = await access('readonly', key);
      if (!record || record.scope !== scope || record.savedAt > Date.now() || Date.now() - record.savedAt > 7 * 86400000) return undefined;
      return record.value;
    },
    write: async (key, reply) => { await access('readwrite', key, reply); },
    saveDelivery: async value => { await access('readwrite', 'delivery', value); },
    loadDelivery: async () => {
      const record = await access('readonly', 'delivery');
      return record?.scope === scope ? record.value : undefined;
    }
  };
}
