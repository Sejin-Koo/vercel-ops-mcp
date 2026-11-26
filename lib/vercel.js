// lib/vercel.js — Vercel REST API 호출 (저장소 연결 관리 전용)
//
// 인증: 환경변수 VERCEL_TOKEN(계정 개인 액세스 토큰). 팀: VERCEL_TEAM_ID(없으면 개인 계정 범위).
// ★ 이 토큰은 계정 전체 권한이다. 이 서버는 본인 게이트키만 등록하고 공유하지 않는다(README).
//   도구가 하는 일은 저장소 목록·연결·연결 해제와 그에 따른 재배포뿐이며, 환경변수 값은 절대 돌려주지 않는다.

const API = "https://api.vercel.com";
const TOKEN = process.env.VERCEL_TOKEN || "";
export const TEAM_ID = process.env.VERCEL_TEAM_ID || "";
export const tokenConfigured = () => !!TOKEN;

export class VercelError extends Error {
  constructor(status, body, path) {
    const msg = (body && body.error && (body.error.message || body.error.code)) || (typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300));
    super(`Vercel API ${status} (${path}): ${msg}`);
    this.status = status;
    this.body = body;
  }
}

/** 팀 범위 쿼리를 붙여 호출. body가 있으면 JSON으로 보낸다 */
export async function vc(method, path, { body, query } = {}) {
  if (!TOKEN) throw new Error("VERCEL_TOKEN 환경변수가 없습니다.");
  const u = new URL(API + path);
  if (TEAM_ID && !u.searchParams.has("teamId")) u.searchParams.set("teamId", TEAM_ID);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 25000);
  let res;
  try {
    res = await fetch(u, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
  } finally {
    clearTimeout(tm);
  }
  const text = await res.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch { j = text; }
  if (!res.ok) throw new VercelError(res.status, j, path);
  return j;
}

// ── 저장소 ───────────────────────────────────────────────────────────────────

/** 저장소 목록(요약). 연결된 프로젝트는 각 저장소 상세에서 채운다 */
export async function listStores() {
  const j = await vc("GET", "/v1/storage/stores");
  const stores = (j && (j.stores || j)) || [];
  return Array.isArray(stores) ? stores : [];
}

export async function getStore(id) {
  const j = await vc("GET", `/v1/storage/stores/${encodeURIComponent(id)}`);
  return j && j.store ? j.store : j;
}

/** 이름 또는 id로 저장소를 찾는다 */
export async function resolveStore(ref) {
  const r = String(ref || "").trim();
  if (!r) throw new Error("store(저장소 이름 또는 store_… id)를 주세요.");
  if (/^store_/.test(r)) return getStore(r);
  const all = await listStores();
  const hit = all.filter((s) => s.name === r || s.id === r);
  if (hit.length === 1) return getStore(hit[0].id);
  if (!hit.length) throw new Error(`저장소 '${r}'을(를) 찾지 못했습니다. 있는 저장소: ${all.map((s) => s.name).join(", ") || "(없음)"}`);
  throw new Error(`이름이 같은 저장소가 ${hit.length}개입니다. store_… id로 지정하세요: ${hit.map((s) => s.id).join(", ")}`);
}

/** 프로젝트 이름 또는 id → {id, name, latestProd} */
export async function resolveProject(ref) {
  const r = String(ref || "").trim();
  if (!r) throw new Error("project(프로젝트 이름 또는 prj_… id)를 주세요.");
  const p = await vc("GET", `/v9/projects/${encodeURIComponent(r)}`);
  return { id: p.id, name: p.name };
}

export function storeSummary(s) {
  const integ = s.product || {};
  return {
    id: s.id,
    이름: s.name,
    종류: s.type === "integration" ? `${(integ.integration && integ.integration.name) || "통합"} — ${integ.name || ""}`.trim() : s.type,
    상태: s.status,
    요금제: s.billingPlan ? `${s.billingPlan.name}${(s.billingPlan.details || []).map((d) => ` · ${d.label} ${d.value}`).join("")}` : undefined,
    연결된_프로젝트: (s.projectsMetadata || []).map((m) => ({
      프로젝트: m.name,
      projectId: m.projectId,
      연결id: m.id,
      환경: m.environments,
      접두어: m.envVarPrefix || "(기본)",
      환경변수: m.environmentVariables,
      민감값: m.makeEnvVarsSensitive,
    })),
  };
}

// ── 연결·해제 ────────────────────────────────────────────────────────────────

/**
 * 저장소를 프로젝트에 연결한다.
 * 1순위: Vercel CLI가 쓰는 저장소 연결 경로(POST /v1/storage/stores/{id}/connections — 접두어 지정 가능)
 * 2순위(통합 저장소이고 1순위가 404·405면): 공식 문서 경로
 *        POST /v1/integrations/installations/{icfg}/resources/{storeId}/connections (접두어 인자 없음)
 */
export async function connectStore(store, projectId, { environments, prefix, sensitive }) {
  const body = { projectId, envVarEnvironments: environments, makeEnvVarsSensitive: sensitive };
  if (prefix) body.envVarPrefix = prefix;
  try {
    const j = await vc("POST", `/v1/storage/stores/${encodeURIComponent(store.id)}/connections`, { body: { ...body, type: store.type } });
    return { route: "storage/stores/connections", result: j };
  } catch (e) {
    const icfg = store.product && store.product.integrationConfigurationId;
    if (!(e instanceof VercelError) || ![404, 405].includes(e.status) || store.type !== "integration" || !icfg) throw e;
    const j = await vc("POST", `/v1/integrations/installations/${encodeURIComponent(icfg)}/resources/${encodeURIComponent(store.id)}/connections`, { body });
    return { route: "integrations/resources/connections", result: j, note: prefix ? "이 경로는 접두어 지정을 받지 않아 저장소 기본 이름으로 환경변수가 만들어졌을 수 있습니다(결과의 환경변수 목록 참고)." : undefined };
  }
}

export async function disconnectStore(store, conn) {
  // Vercel CLI(integration resource disconnect)가 쓰는 경로. 공식 REST 문서에는 아직 없다.
  const j = await vc("DELETE", `/v1/storage/stores/${encodeURIComponent(store.id)}/connections/${encodeURIComponent(conn.id)}`);
  return { route: "storage/stores/connections", result: j };
}

// ── 재배포 ───────────────────────────────────────────────────────────────────

/** 프로덕션 최신 배포를 같은 소스로 다시 배포(환경변수 반영용) */
export async function redeployProduction(projectId, projectName) {
  const list = await vc("GET", "/v6/deployments", { query: { projectId, target: "production", limit: 1 } });
  const last = list && list.deployments && list.deployments[0];
  if (!last) return { 재배포: "건너뜀", 사유: "프로덕션 배포 기록이 없습니다." };
  const d = await vc("POST", "/v13/deployments", { query: { forceNew: 1 }, body: { name: projectName, deploymentId: last.uid, target: "production" } });
  return { 재배포: "시작", 배포id: d.id, 상태: d.readyState || d.status, 원본배포: last.uid, 확인: "1~2분 뒤 vercel_storage_list나 배포 목록에서 READY인지 확인하세요." };
}
