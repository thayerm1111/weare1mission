import { getConfig, listOrders, listPositions, type TLEnv } from './tradelocker';

export function field(row: unknown, cols: Record<string, number> | undefined, keys: string[]): unknown {
  for (const key of keys) {
    const v = Array.isArray(row) ? (cols?.[key] == null ? undefined : row[cols[key]]) : row && typeof row === 'object' ? (row as Record<string, unknown>)[key] : undefined;
    if (v !== null && v !== undefined && v !== '') return v;
  }
}
export function columnMap(config: unknown, section: string): Record<string, number> | undefined {
  const root = config as Record<string, unknown> | null;
  const d = (root?.d ?? root) as Record<string, unknown> | null;
  const raw = d?.[section] as Record<string, unknown> | unknown[] | undefined;
  const cols = Array.isArray(raw) ? raw : raw?.columns;
  if (!Array.isArray(cols)) return undefined;
  return Object.fromEntries(cols.map((c, i) => [String(c.id ?? c.key ?? c.name ?? ''), i]));
}
export function protectiveStop(orders: unknown[], cols: Record<string,number> | undefined, positionId: string): number | null {
  const matches: number[] = [];
  for (const o of orders) {
    if (String(field(o, cols, ['positionId','positionID','posId'])) !== positionId) continue;
    const type = String(field(o, cols, ['type','orderType']) ?? '').toLowerCase();
    const status = String(field(o, cols, ['status','orderStatus']) ?? '').toLowerCase().replace(/[ _-]/g,'');
    if (!type.includes('stop') || !['new','working','open','pending','accepted','partiallyfilled'].includes(status)) continue;
    const px = Number(field(o, cols, ['stopPrice','stopLoss','triggerPrice','price']));
    if (Number.isFinite(px) && px > 0) matches.push(px);
  }
  // Ambiguous replacement orders are not proof of the effective stop.
  return matches.length === 1 ? matches[0] : null;
}
export function positionForOrder(history: unknown[], cols: Record<string,number> | undefined, orderId: string): string | null {
  const ids = new Set<string>();
  for (const row of history) {
    if (String(field(row, cols, ['id','orderId'])) !== orderId) continue;
    const pid = field(row, cols, ['positionId','positionID']);
    if (pid != null && String(pid) !== '0') ids.add(String(pid));
  }
  return ids.size === 1 ? [...ids][0] : null;
}
const configs = new Map<string, { at:number; data:unknown }>();
export async function brokerConfig(env:TLEnv, token:string, accNum:string, accountId:string):Promise<unknown> {
  const key = `${env}:${accountId}`;
  const hit = configs.get(key);
  if (hit && Date.now()-hit.at < 300_000) return hit.data;
  const r = await getConfig(env,token,accNum);
  if (!r.ok) throw new Error('broker_config_unavailable');
  configs.set(key,{at:Date.now(),data:r.data});
  return r.data;
}
export async function readProtectiveStop(env:TLEnv, token:string, accNum:string, accountId:string, positionId:string):Promise<number|null> {
  const config = await brokerConfig(env,token,accNum,accountId);
  const positions = await listPositions(env,token,accNum,accountId);
  if (!positions.ok) return null;
  const pc = columnMap(config,'positionsConfig');
  const pos = positions.data.find(p => String(field(p,pc,['id','positionId','positionID'])) === positionId);
  if (!pos) return null;
  const stop = Number(field(pos,pc,['stopLoss','stopLossPrice','sl']));
  if (Number.isFinite(stop) && stop > 0) return stop;
  const orders = await listOrders(env,token,accNum,accountId);
  return orders.ok ? protectiveStop(orders.data,columnMap(config,'ordersConfig'),positionId) : null;
}
