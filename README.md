# vercel-ops-mcp

Vercel 저장소(Storage — Upstash Redis·Blob 등)를 프로젝트에 **연결·해제**하고 연결 현황을 조회하는 MCP 서버입니다.
대시보드의 Storage → Connect Project / Disconnect를 대화에서 할 수 있게 합니다.

**본인 전용 서버입니다.** 서버가 계정 전체 권한의 Vercel 토큰을 쓰므로 게이트키는 본인 키만 등록하고 공유하지 않습니다.

## 도구

| 도구 | 하는 일 | 바꾸는가 |
|---|---|---|
| `vercel_storage_list` | 저장소 목록, 저장소별 연결 프로젝트·환경·접두어·환경변수 이름·민감값 여부 (`store`·`project`로 거르기) | 아니오 |
| `vercel_storage_connect` | 저장소를 프로젝트에 연결(환경·접두어·민감값 지정) → 만들어진 환경변수 이름을 재조회해 돌려줌. `redeploy=true`면 프로덕션 재배포, `dry_run=true`면 계획만 | 예 |
| `vercel_storage_disconnect` | 연결 해제. `confirm`에 프로젝트 이름을 정확히 넣어야 실행, 비우면 미리보기만 | 예(되돌릴 수 없음) |

- 환경변수 **값**은 어떤 도구도 돌려주지 않습니다(이름만).
- 이미 연결된 조합에 `connect`를 부르면 바꾸지 않고 현재 연결을 알려 줍니다(설정을 바꾸려면 해제 후 다시 연결).
- 연결·해제는 다음 배포부터 반영됩니다.

## 호출 경로

| 작업 | 경로 | 근거 |
|---|---|---|
| 목록 | `GET /v1/storage/stores`, `GET /v1/storage/stores/{id}` | Vercel CLI `integration resource` |
| 연결 | `POST /v1/storage/stores/{id}/connections` `{projectId, envVarEnvironments, envVarPrefix?, makeEnvVarsSensitive, type}` — 404·405면 `POST /v1/integrations/installations/{icfg}/resources/{id}/connections`(공식 문서, 접두어 없음) | CLI · REST 문서 |
| 해제 | `DELETE /v1/storage/stores/{id}/connections/{연결id(spc_…)}` | CLI(공식 REST 문서에는 없음) |
| 재배포 | `POST /v13/deployments?forceNew=1` `{name, deploymentId, target:"production"}` | REST 문서 |

## 환경변수

| 이름 | 값 |
|---|---|
| `VERCEL_TOKEN` | Vercel 개인 액세스 토큰 |
| `VERCEL_TEAM_ID` | 팀 id(`team_…`). 없으면 개인 계정 범위 |
| `MCP_GATE_KEYS` | 허용 게이트키(본인 키만) |
| `MCP_GATE_MODE` | `enforce` |

## 로컬 시험

```bash
npm install
node --env-file=.env smoke.mjs                                   # 도구 목록
node --env-file=.env smoke.mjs vercel_storage_list '{}'
node --env-file=.env smoke.mjs vercel_storage_connect '{"store":"<저장소>","project":"<프로젝트>","dry_run":true}'
```
