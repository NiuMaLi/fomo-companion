import { openDB, type DBSchema } from 'idb';
import { DEFAULT_SETTINGS, settingsSchema, type Event, type Log, type Order, type Settings } from '../shared/model';
import { LEGACY_SOL_ASSET } from './legacy';

interface Database extends DBSchema {
  orders: { key: string; value: Order };
  events: { key: string; value: Event };
  logs: { key: string; value: Log; indexes: { at: number } };
  state: { key: string; value: unknown };
}
export const database = (name = 'fomo-companion') => openDB<Database>(name, 4, {
  async upgrade(db, version, _next, tx) {
    if (version < 1) {
      db.createObjectStore('orders', { keyPath: 'id' });
      db.createObjectStore('events', { keyPath: 'id' }); db.createObjectStore('state');
    }
    if (version < 3) {
      db.createObjectStore('logs', { keyPath: 'id' }).createIndex('at', 'at');
      // Previous releases could only simulate. Never arm their orders for real execution.
      let cursor = await tx.objectStore('orders').openCursor();
      while (cursor) {
        const order = cursor.value;
        await cursor.update({ ...order, asset: version === 1 ? LEGACY_SOL_ASSET : order.asset,
          legacy: true, status: order.status === 'waiting' ? 'archived' : order.status,
          reason: '旧版模拟记录已归档，不会提交真实交易' });
        cursor = await cursor.continue();
      }
      let state = await tx.objectStore('state').openCursor();
      while (state) {
        if (String(state.key).startsWith('paper:')) await state.delete();
        state = await state.continue();
      }
      await tx.objectStore('state').put(DEFAULT_SETTINGS, 'settings');
      if (version > 0) await tx.objectStore('logs').put({ id: 'migration-v3', at: Date.now(), category: 'system',
        level: 'info', code: 'upgrade', message: '已移除模拟仓位，归档旧条件单，并关闭自动监控与真实下单' });
    }
    if (version === 3) {
      let cursor = await tx.objectStore('orders').openCursor();
      while (cursor) {
        if (cursor.value.status === 'waiting') await cursor.update({ ...cursor.value, status: 'archived', reason: '真实执行引擎已更新，请重新创建并确认条件单' });
        cursor = await cursor.continue();
      }
      const parsed = settingsSchema.safeParse(await tx.objectStore('state').get('settings'));
      await tx.objectStore('state').put({ ...(parsed.success ? parsed.data : DEFAULT_SETTINGS), automatic: false, realTrading: false }, 'settings');
    }
  },
});
export type DB = Awaited<ReturnType<typeof database>>;
export async function readSettings(db: DB): Promise<Settings> {
  const parsed = settingsSchema.safeParse(await db.get('state', 'settings'));
  return parsed.success ? parsed.data : structuredClone(DEFAULT_SETTINGS);
}
