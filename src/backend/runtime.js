// Mutable backend runtime singletons (PostgreSQL pool, Redis client, BullMQ
// queue). Created once during startup in api.js's init() and exported as ESM
// live bindings, so any module that imports them observes the initialized
// instances without threading them through every call.

export let pool = null;
export let redis = null;
export let redisSub = null;
export let queue = null;

export function setPool(p) {
  pool = p;
}
export function setRedis(r) {
  redis = r;
}
export function setRedisSub(r) {
  redisSub = r;
}
export function setQueue(q) {
  queue = q;
}
