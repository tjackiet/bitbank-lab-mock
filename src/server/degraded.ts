import { ErrorCode, err } from "../routes/envelope.ts";

/**
 * 状態ファイルへの書き出しに失敗した後の振る舞い。
 *
 * - `degrade`（既定）: 状態を変える要求を断り、読み取りは生かす
 * - `ignore`: v0.1.0 の挙動。失敗しても何も断らない（警告と `persist` の記録だけ）
 */
export type PersistFailureMode = "degrade" | "ignore";

/**
 * 劣化中も通す読み取り経路（`<METHOD> <ルートの url>`）。
 *
 * **`POST /v1/user/spot/orders_info` が読み取りである点に注意。** メソッドで機械的に
 * 判定すると、注文状態の照合の主経路（`docs/plan-lab-mock.md` の R1）を劣化中に殺す。
 *
 * `HEAD` は Fastify が `GET` から自動登録するので、判定では `GET` と同じに扱う。
 *
 * **private stream の 2 経路も読み取りに入れる。** `GET /v1/user/subscribe` は固定の値を
 * 返すだけで、`GET /_stream/private` は状態を読み出して送るだけである。劣化中は状態が
 * 動かないので stream には何も流れないが、接続そのものは断らない（読み取りを生かす、という
 * 劣化モードの約束に揃える）。
 */
export const READ_ROUTES: ReadonlySet<string> = new Set([
  "GET /v1/user/spot/order",
  "POST /v1/user/spot/orders_info",
  "GET /v1/user/assets",
  "GET /v1/user/spot/active_orders",
  "GET /v1/user/spot/trade_history",
  "GET /v1/user/subscribe",
  "GET /_stream/private",
  "GET /_control/state",
]);

/**
 * 劣化中に断る経路。
 *
 * 判定そのものは「読み取りに無ければ断る」という fail-closed なので、この集合は
 * **列挙漏れを起動時に落とすため**だけにある（`assertRouteClassified()`）。
 * 新しい経路を足した人は、どちらかに載せるまでサーバを起動できない。
 */
export const MUTATING_ROUTES: ReadonlySet<string> = new Set([
  "POST /v1/user/spot/order",
  "POST /v1/user/spot/cancel_order",
  "POST /v1/user/spot/cancel_orders",
  "POST /_control/reset",
  "POST /_control/tick",
  "POST /_control/clock",
  "POST /_control/orders/:order_id/fill",
]);

/** 判定に使う鍵。`HEAD` は `GET` に寄せる（Fastify が GET から自動登録するため）。 */
export function routeKey(method: string, url: string): string {
  return `${method === "HEAD" ? "GET" : method} ${url}`;
}

/** 劣化中も通す経路か。**分類に無い経路は通さない**（fail-closed）。 */
export function isReadRoute(method: string, url: string): boolean {
  return READ_ROUTES.has(routeKey(method, url));
}

/**
 * 登録された経路がすべて分類済みかを検査する。未分類なら throw して起動を止める。
 *
 * 分類そのものは fail-closed（読み取りに無ければ断る）なので、漏れても状態は壊れない。
 * ただし読み取り経路を載せ忘れると劣化中にその口が死ぬので、黙って進ませない。
 * 壊れた状態ファイルで起動しないのと同じ姿勢（`docs/fidelity.md`）。
 */
export function assertRouteClassified(method: string, url: string): void {
  const key = routeKey(method, url);
  if (READ_ROUTES.has(key) || MUTATING_ROUTES.has(key)) return;
  throw new Error(
    `unclassified route ${key}: add it to READ_ROUTES or MUTATING_ROUTES in src/server/degraded.ts ` +
      "(persist が失敗した後に断るかどうかを決める分類です)",
  );
}

/** `/_control/` の劣化時の応答。素の JSON + 503（封筒には包まない）。 */
export const CONTROL_DEGRADED_BODY = { error: "PERSIST_DEGRADED" } as const;

/**
 * 劣化時に返す本文と HTTP ステータス。
 *
 * 互換ルートは bitbank 封筒 + `INTERNAL`（70001）。採番の飽和で既に使っているコードで、
 * 「モックの内部都合で断った」ことを表す。ステータスは既存の `INTERNAL` の使い方に
 * 合わせて 200（封筒の `success: 0` が失敗を表す）。
 *
 * `/_control/` は bitbank API に存在しないので素の JSON + 503 を返す。
 */
export function degradedResponse(url: string): { statusCode: number; body: unknown } {
  if (url.startsWith("/_control/")) {
    return { statusCode: 503, body: CONTROL_DEGRADED_BODY };
  }
  return { statusCode: 200, body: err(ErrorCode.INTERNAL) };
}
