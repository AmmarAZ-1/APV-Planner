// Autosave to IndexedDB so traced plans (and their images, stored as Blobs) survive a reload.
// Every call is best-effort: private windows or blocked storage simply disable autosave.

const DB_NAME = 'apv-planner';
const STORE = 'kv';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(result instanceof IDBRequest ? result.result : result); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

/**
 * @param {object} project  @param {Record<string, Blob>} images keyed by floor id
 * Images are stored as raw bytes rather than Blobs: Blob-in-IndexedDB is unreliable in
 * some embedded/private browser contexts.
 */
export async function saveLocal(project, images) {
  try {
    const raw = {};
    for (const [id, blob] of Object.entries(images)) raw[id] = { type: blob.type, bytes: await blob.arrayBuffer() };
    await tx('readwrite', (s) => s.put({ project, images: raw, savedAt: Date.now() }, 'current'));
    return true;
  } catch {
    return false;
  }
}

export async function loadLocal() {
  try {
    const rec = await tx('readonly', (s) => s.get('current'));
    if (!rec) return null;
    const images = {};
    for (const [id, v] of Object.entries(rec.images || {})) {
      images[id] = v instanceof Blob ? v : new Blob([v.bytes], { type: v.type || 'image/png' });
    }
    return { ...rec, images };
  } catch {
    return null;
  }
}

export async function clearLocal() {
  try {
    await tx('readwrite', (s) => s.delete('current'));
  } catch { /* ignore */ }
}
