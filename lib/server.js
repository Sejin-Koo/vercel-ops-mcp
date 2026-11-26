// vercel-ops-mcp — Vercel 저장소(Storage) 연결 관리 MCP 서버 (본인 전용)
//
// 도구 3개:
//   vercel_storage_list        저장소 목록과 저장소별 연결된 프로젝트·환경변수 이름
//   vercel_storage_connect     저장소를 프로젝트에 연결(환경·접두어·민감값 지정) → 만들어진 환경변수 이름 확인
//   vercel_storage_disconnect  연결 해제(되돌릴 수 없으므로 confirm 인자 필요)
// 환경변수 "값"은 어떤 경우에도 돌려주지 않는다(이름만).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  TEAM_ID,
  tokenConfigured,
  listStores,
  getStore,
  resolveStore,
  resolveProject,
  storeSummary,
  connectStore,
  disconnectStore,
  redeployProduction,
} from "./vercel.js";

export const SERVER_VERSION = "1.0.0";

const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ content: [{ type: "text", text: `오류: ${e && e.message ? e.message : String(e)}` }], isError: true });

const bool = (def = false) =>
  z.union([z.boolean(), z.enum(["true", "false"])]).transform((v) => v === true || v === "true").default(def);

const ENV_ALL = ["production", "preview", "development"];
const envList = z
  .union([z.array(z.string()), z.string()])
  .transform((v) => {
    let a = Array.isArray(v) ? v : String(v).trim().startsWith("[") ? JSON.parse(String(v)) : String(v).split(/[\s,]+/);
    a = a.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    if (a.includes("all")) return ENV_ALL.slice();
    return [...new Set(a)];
  })
  .refine((a) => a.length > 0 && a.every((x) => ENV_ALL.includes(x)), { message: "environments는 production·preview·development(또는 all) 중에서 고르세요." });

function findConn(store, projectRef) {
  const r = String(projectRef || "").trim();
  return (store.projectsMetadata || []).find((m) => m.projectId === r || m.name === r) || null;
}

export function buildServer() {
  const server = new McpServer({ name: "vercel-ops-mcp", version: SERVER_VERSION });

  // ── 1. 목록 ────────────────────────────────────────────────────────────────
  server.registerTool(
    "vercel_storage_list",
    {
      title: "Vercel 저장소 목록·연결 현황",
      description:
        "Vercel 계정(팀)의 저장소(Upstash Redis·Blob·Postgres·Edge Config 등)와 저장소마다 연결된 프로젝트, " +
        "연결된 환경(production·preview·development), 환경변수 접두어, 만들어진 환경변수 이름, 민감값 여부를 보여 준다. " +
        "store를 주면 그 저장소 하나만, project를 주면 그 프로젝트에 연결된 저장소만 걸러 보여 준다. 환경변수 값은 보여 주지 않는다.",
      inputSchema: {
        store: z.string().optional().describe("저장소 이름 또는 store_… id (선택)"),
        project: z.string().optional().describe("프로젝트 이름 또는 prj_… id — 이 프로젝트에 연결된 저장소만 (선택)"),
      },
    },
    async ({ store, project }) => {
      try {
        if (!tokenConfigured()) throw new Error("서버에 VERCEL_TOKEN이 설정되어 있지 않습니다.");
        let stores;
        if (store) stores = [await resolveStore(store)];
        else {
          const all = await listStores();
          stores = await Promise.all(all.map((s) => getStore(s.id).catch(() => s)));
        }
        let rows = stores.map(storeSummary);
        if (project) {
          const p = String(project).trim();
          rows = rows.filter((r) => r.연결된_프로젝트.some((c) => c.프로젝트 === p || c.projectId === p));
        }
        return ok({ 팀: TEAM_ID || "(개인 계정)", 저장소수: rows.length, 저장소: rows });
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── 2. 연결 ────────────────────────────────────────────────────────────────
  server.registerTool(
    "vercel_storage_connect",
    {
      title: "저장소를 프로젝트에 연결",
      description:
        "저장소를 Vercel 프로젝트에 연결해 접속용 환경변수를 프로젝트에 만든다(대시보드 Storage → Connect Project와 같은 일). " +
        "environments로 연결할 환경을, prefix로 환경변수 접두어를(이름이 붙는 규칙은 저장소 종류마다 달라 결과의 환경변수 이름으로 확인 — 실측: Upstash에 OPSTEST를 주면 OPSTEST_KV_REST_API_URL 등), sensitive로 민감값 여부를 정한다. " +
        "연결 뒤 실제로 만들어진 환경변수 이름을 다시 조회해 돌려준다. 환경변수는 다음 배포부터 반영되므로 redeploy=true면 프로덕션을 같은 소스로 다시 배포한다. " +
        "이미 연결돼 있으면 아무것도 바꾸지 않고 현재 연결을 알려 준다(환경·접두어를 바꾸려면 해제 후 다시 연결). " +
        "dry_run=true면 바꾸지 않고 무엇을 할지만 보여 준다.",
      inputSchema: {
        store: z.string().describe("저장소 이름 또는 store_… id"),
        project: z.string().describe("프로젝트 이름 또는 prj_… id"),
        environments: envList.default(["production", "preview"]).describe("연결할 환경: production·preview·development 또는 all (기본 production, preview)"),
        prefix: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "접두어는 영문 대문자·숫자·밑줄로 쓰세요(예: KV)").optional().describe("환경변수 접두어(선택). 비우면 저장소 기본 이름. 실제 이름은 결과에서 확인"),
        sensitive: bool(true).describe("민감값(Sensitive)으로 만들지 — 기본 true. 민감값은 대시보드·API에서 값을 다시 볼 수 없다"),
        redeploy: bool(false).describe("연결 뒤 프로덕션을 다시 배포해 환경변수를 반영할지(기본 false)"),
        dry_run: bool(false).describe("true면 바꾸지 않고 계획만 보여 줌"),
      },
    },
    async ({ store, project, environments, prefix, sensitive, redeploy, dry_run }) => {
      try {
        if (!tokenConfigured()) throw new Error("서버에 VERCEL_TOKEN이 설정되어 있지 않습니다.");
        const st = await resolveStore(store);
        const pj = await resolveProject(project);
        const existing = findConn(st, pj.id);
        if (existing) {
          return ok({
            결과: "이미 연결됨 — 바꾸지 않았습니다",
            저장소: st.name,
            프로젝트: pj.name,
            현재연결: storeSummary(st).연결된_프로젝트.find((c) => c.projectId === pj.id),
            안내: "환경·접두어·민감값을 바꾸려면 vercel_storage_disconnect로 해제한 뒤 다시 연결하세요.",
          });
        }
        const plan = { 저장소: `${st.name} (${st.id})`, 프로젝트: `${pj.name} (${pj.id})`, 환경: environments, 접두어: prefix || "(저장소 기본)", 민감값: sensitive, 재배포: redeploy };
        if (dry_run) return ok({ 결과: "계획만 표시(dry_run) — 바꾸지 않았습니다", 계획: plan });

        const r = await connectStore(st, pj.id, { environments, prefix, sensitive });
        // 연결 결과 재조회(환경변수 이름 확인)
        let after = null;
        for (let i = 0; i < 4 && !after; i++) {
          const s2 = await getStore(st.id);
          after = findConn(s2, pj.id);
          if (!after) await new Promise((res) => setTimeout(res, 1500));
        }
        const out = {
          결과: after ? "연결됨" : "연결 요청은 성공했으나 재조회에 아직 안 보입니다 — 잠시 뒤 vercel_storage_list로 확인하세요",
          계획: plan,
          사용경로: r.route,
          연결: after ? { 연결id: after.id, 환경: after.environments, 접두어: after.envVarPrefix || "(기본)", 환경변수: after.environmentVariables, 민감값: after.makeEnvVarsSensitive } : undefined,
          참고: r.note,
        };
        if (redeploy) {
          try { out.재배포 = await redeployProduction(pj.id, pj.name); } catch (e) { out.재배포 = { 실패: e.message, 안내: "연결은 끝났습니다. 다음 push 때 반영되거나 대시보드에서 Redeploy하세요." }; }
        } else out.안내 = "환경변수는 다음 배포부터 반영됩니다(redeploy=true로 다시 부르거나 다음 push 때 반영).";
        return ok(out);
      } catch (e) {
        return fail(e);
      }
    }
  );

  // ── 3. 해제 ────────────────────────────────────────────────────────────────
  server.registerTool(
    "vercel_storage_disconnect",
    {
      title: "저장소 연결 해제 (되돌릴 수 없음)",
      description:
        "저장소와 프로젝트의 연결을 끊는다. 연결로 만들어진 환경변수가 프로젝트에서 지워져, 다음 배포부터 그 저장소를 쓰는 코드가 동작하지 않는다. " +
        "되돌리려면 다시 연결해야 하며 접두어·환경을 같게 지정해야 한다. confirm에 프로젝트 이름을 그대로 넣어야 실행한다 — 사용자의 명시적 지시 없이 부르지 말 것. " +
        "confirm 없이 부르면 해제될 연결과 지워질 환경변수 이름만 보여 준다.",
      inputSchema: {
        store: z.string().describe("저장소 이름 또는 store_… id"),
        project: z.string().describe("프로젝트 이름 또는 prj_… id"),
        confirm: z.string().optional().describe("실행 확인 — 프로젝트 이름을 정확히 입력. 비우면 미리보기만"),
      },
    },
    async ({ store, project, confirm }) => {
      try {
        if (!tokenConfigured()) throw new Error("서버에 VERCEL_TOKEN이 설정되어 있지 않습니다.");
        const st = await resolveStore(store);
        const pj = await resolveProject(project);
        const conn = findConn(st, pj.id);
        if (!conn) return ok({ 결과: "연결돼 있지 않습니다 — 바꾸지 않았습니다", 저장소: st.name, 프로젝트: pj.name });
        const view = storeSummary(st).연결된_프로젝트.find((c) => c.projectId === pj.id);
        if (!confirm || String(confirm).trim() !== pj.name) {
          return ok({
            결과: "미리보기 — 바꾸지 않았습니다",
            해제할연결: view,
            영향: "위 환경변수가 프로젝트에서 지워지고, 다음 배포부터 이 저장소를 쓰는 코드가 실패합니다.",
            실행방법: `confirm에 "${pj.name}"을(를) 넣어 다시 부르세요.`,
          });
        }
        const r = await disconnectStore(st, conn);
        const s2 = await getStore(st.id);
        const still = findConn(s2, pj.id);
        return ok({
          결과: still ? "해제 요청은 성공했으나 아직 연결이 보입니다 — 잠시 뒤 다시 확인하세요" : "해제됨",
          해제한연결: view,
          사용경로: r.route,
          안내: "현재 배포는 옛 환경변수를 그대로 들고 있습니다. 다음 배포부터 반영됩니다.",
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  return server;
}
