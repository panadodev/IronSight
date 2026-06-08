const KEY = "assoc-reports";
const HIDE_KEY = "assoc-hidden";
function readAll() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function writeAll(rows) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(rows));
  } catch {
  }
}
function pairKey(a, b) {
  return [a, b].sort().join("|");
}
function readHidden() {
  if (typeof window === "undefined") return /* @__PURE__ */ new Set();
  try {
    const raw = window.localStorage.getItem(HIDE_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return /* @__PURE__ */ new Set();
  }
}
function writeHidden(set) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HIDE_KEY, JSON.stringify(Array.from(set)));
  } catch {
  }
}
function hideAssociation(a, b) {
  const s = readHidden();
  s.add(pairKey(a, b));
  writeHidden(s);
}
function unhideAssociation(a, b) {
  const s = readHidden();
  s.delete(pairKey(a, b));
  writeHidden(s);
}
function isAssociationHidden(a, b) {
  return readHidden().has(pairKey(a, b));
}
function addAssociationReports(subject, others) {
  if (others.length === 0) return;
  const now = Date.now();
  const rows = readAll();
  const hidden = readHidden();
  for (const o of others) {
    if (o.steamId === subject.steamId) continue;
    rows.push({
      a: subject.steamId,
      aName: subject.name,
      b: o.steamId,
      bName: o.name,
      at: now
    });
    hidden.delete(pairKey(subject.steamId, o.steamId));
  }
  writeAll(rows);
  writeHidden(hidden);
}
function getAssociationsFor(subjectId) {
  const out = /* @__PURE__ */ new Map();
  for (const r of readAll()) {
    let otherId = null;
    let otherName = "";
    if (r.a === subjectId) {
      otherId = r.b;
      otherName = r.bName;
    } else if (r.b === subjectId) {
      otherId = r.a;
      otherName = r.aName;
    }
    if (!otherId) continue;
    const cur = out.get(otherId);
    if (cur) {
      cur.count += 1;
      if (r.at > cur.lastAt) cur.lastAt = r.at;
    } else {
      out.set(otherId, { name: otherName, count: 1, lastAt: r.at });
    }
  }
  return out;
}
function getAssociationCount(a, b) {
  return readAll().filter(
    (r) => r.a === a && r.b === b || r.a === b && r.b === a
  ).length;
}
export {
  addAssociationReports,
  getAssociationCount,
  getAssociationsFor,
  hideAssociation,
  isAssociationHidden,
  unhideAssociation
};
