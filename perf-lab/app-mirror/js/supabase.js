// perf-lab 전용 가짜 supabase 클라이언트.
// 실제 앱은 로그인 + nrc_sync_snapshots 테이블에서 수집 JSON을 읽어오지만,
// 여기서는 real-org-data.js에 들어있는 JSON을 그 자리에서 그대로 돌려준다.
// 로그인이 안 된 상태(ownerId=null)로 동작해서, 저장은 전부 이 브라우저(localStorage)로만 간다.

function makeBuilder(table) {
  const builder = {
    select() { return builder; },
    eq() { return builder; },
    order() { return builder; },
    limit() { return builder; },
    async maybeSingle() {
      if (table === "nrc_sync_snapshots") {
        return {
          data: {
            payload: REAL_ORG_DATA,
            collected_at: REAL_ORG_DATA.mainStats?.["수집일시"] || new Date().toISOString(),
            source_account_id: REAL_ORG_DATA.sourceAccountId,
          },
          error: null,
        };
      }
      // nrc_closing_plans 등 다른 테이블은 로컬 저장 모드에서는 조회되지 않음
      return { data: null, error: null };
    },
    async insert() { return { data: null, error: null }; },
    async delete() { return { data: null, error: null }; },
    async upsert() { return { data: null, error: { message: "perf-lab: supabase 저장은 목업이라 항상 로컬로 저장됩니다." } }; },
  };
  return builder;
}

export const supabase = {
  auth: {
    getUser: () => Promise.resolve({ data: { user: null } }),
  },
  from(table) {
    return makeBuilder(table);
  },
};
