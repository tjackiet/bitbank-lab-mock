import type { FastifyPluginAsync } from "fastify";
import { isActive, type OrderRecord } from "../engine/state.ts";
import { cancelOrder } from "../engine/transitions.ts";
import { CancelOrderRequestSchema, CancelOrdersRequestSchema } from "../schemas/requests.ts";
import { ErrorCode, type ErrorCodeValue, err, ok } from "./envelope.ts";
import { formatOrder } from "./format.ts";
import { asRecord, isMissing } from "./params.ts";

/**
 * `cancel_orders` の `order_ids` の上限。公式のパラメータ表が持つ値そのもの
 * （`rest-api.md:548` "order ids. Up to 30 ids can be specified" / `rest-api_JP.md:556`
 * 「注文ID。最大30個まで指定可能」。コミット `0badd680`）。
 *
 * **この上限は `cancel_orders` にだけある。** `orders_info` の `order_ids` には公式の記載が
 * 無いので（`rest-api.md:600` / `rest-api_JP.md:608`）、`src/routes/order-info.ts` には
 * 同じ検査を置かない。**非対称は公式の仕様なので、揃えないこと**
 * （`docs/fidelity.md` の「一括取消の件数上限」節）。
 */
export const MAX_CANCEL_ORDER_IDS = 30;

/**
 * 取消 2 経路のスキーマ検証の失敗を、落ちたフィールドの公式コードへ割り振る。
 *
 * **id が落ちたなら id のコード**（`cancel_order` は `40013`、`cancel_orders` は `40014`）。
 * どちらも実 API が「読めない id」に返すことを照会側で実測してある番号で、
 * **取消の 2 経路では未実測**（取消の実測には実弾の注文が要る）。照会側からの外挿である。
 *
 * **残る `pair` は `20003` に据え置く。** この 2 経路は `pair` の欠落を先に見ていないので、
 * 落ちた `pair` が「欠落」（公式は `30009`）なのか「不正値」（公式は `40017`）なのかを
 * ここでは決められない。**どちらかに倒すと推測でコードを割り当てることになる**ので、
 * 「どのフィールドか特定できない不正値」の受け皿である `20003` に残す
 * （`docs/fidelity.md` の「エラーコード」節）。
 *
 * id と `pair` が同時に落ちたときは id のコードが勝つ。**実 API の優先順は未実測**で、
 * 具体的なコードを返せる側を採っただけである。
 */
function cancelSchemaErrorCode(
  paths: Array<PropertyKey | undefined>,
  idField: "order_id" | "order_ids",
  idCode: ErrorCodeValue,
): ErrorCodeValue {
  return paths.includes(idField) ? idCode : ErrorCode.INVALID_PARAMETER;
}

function terminalCancelCode(order: OrderRecord): number | null {
  if (order.status === "CANCELED_UNFILLED" || order.status === "CANCELED_PARTIALLY_FILLED") {
    return ErrorCode.ALREADY_CANCELED;
  }
  if (order.status === "FULLY_FILLED") return ErrorCode.ALREADY_EXECUTED;
  if (order.status === "REJECTED") return ErrorCode.ORDER_NOT_FOUND;
  return null;
}

export const cancelOrderRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/v1/user/spot/cancel_order", async (request) => {
    const body = asRecord(request.body);
    // 本文そのものが object でない。フィールドを特定できないので `20003` 据え置き。
    if (!body) {
      return err(ErrorCode.INVALID_PARAMETER);
    }
    if (isMissing(body.order_id)) {
      return err(ErrorCode.MISSING_ORDER_ID);
    }
    const parsed = CancelOrderRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return err(
        cancelSchemaErrorCode(
          parsed.error.issues.map((i) => i.path[0]),
          "order_id",
          ErrorCode.INVALID_ORDER_ID,
        ),
      );
    }
    const store = fastify.store;
    await store.tick();
    const wantId = String(parsed.data.order_id);
    const target = store.state().orders.find((o) => o.id === wantId && o.pair === parsed.data.pair);
    if (!target) return err(ErrorCode.ORDER_NOT_FOUND);
    const terminal = terminalCancelCode(target);
    if (terminal !== null) return err(terminal);
    if (!isActive(target)) return err(ErrorCode.ORDER_NOT_FOUND);
    const r = cancelOrder(store.state(), wantId, new Date(store.now()).toISOString());
    if (!r.success) return err(ErrorCode.ORDER_NOT_FOUND);
    await store.commit(r.data.state);
    return ok(formatOrder(r.data.order));
  });

  fastify.post("/v1/user/spot/cancel_orders", async (request) => {
    const body = asRecord(request.body);
    // 本文そのものが object でない。フィールドを特定できないので `20003` 据え置き。
    if (!body) {
      return err(ErrorCode.INVALID_PARAMETER);
    }
    if (isMissing(body.order_ids)) {
      return err(ErrorCode.MISSING_ORDER_IDS);
    }
    const parsed = CancelOrdersRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return err(
        cancelSchemaErrorCode(
          parsed.error.issues.map((i) => i.path[0]),
          "order_ids",
          ErrorCode.INVALID_ORDER_ID_ARRAY,
        ),
      );
    }
    // 件数の上限は**状態を触る前**に見る。`store.tick()` は market モードで約定を state へ
    // 入れるので、後ろに置くと「断ったのに状態が変わった」になる。断ったときは 1 件も
    // 取り消さないだけでなく、約定も進めない。
    //
    // 位置をスキーマ検証の**後**にしたのは、`order_ids` が id の配列であることを先に
    // 確かめてから数えるためである。**31 件のうち 1 件が不正値だったときどちらのコードが
    // 勝つかは実測していない**（実 API で取消を測れない）。既存の（実測済みの）優先順を
    // 動かさない位置に足した（`docs/fidelity.md` の「一括取消の件数上限」節）。
    if (parsed.data.order_ids.length > MAX_CANCEL_ORDER_IDS) {
      return err(ErrorCode.TOO_MANY_ORDERS);
    }
    const store = fastify.store;
    await store.tick();
    const wantIds = parsed.data.order_ids.map((i) => String(i));
    const working = store.state();
    const toCancel: string[] = [];
    for (const id of wantIds) {
      const target = working.orders.find((o) => o.id === id && o.pair === parsed.data.pair);
      // そのペアの注文に解決しない id（存在しない / 別のペア）は黙って飛ばす。
      // エラーにはせず、解決した分だけ取り消す（docs/fidelity.md の同行）。
      if (!target) continue;
      const terminal = terminalCancelCode(target);
      if (terminal !== null) return err(terminal);
      if (isActive(target)) toCancel.push(id);
    }
    if (toCancel.length === 0) return err(ErrorCode.ORDER_NOT_FOUND);

    const now = new Date(store.now()).toISOString();
    let next = working;
    const canceled = [];
    for (const id of toCancel) {
      const r = cancelOrder(next, id, now);
      // 失敗を読み飛ばす経路は**同じ id が order_ids に 2 回以上来たとき**に踏む。
      // `toCancel` は重複を落とさないので同じ id が並び、2 件目以降は直前の取消で
      // 終端になった注文に当たって `ORDER_NOT_ACTIVE` で失敗する。防御的な保険ではなく
      // 到達するので、消さないこと。
      // 応答の `orders` が `order_ids` より短くなる理由はこれだけではない。上の
      // `if (!target) continue;` が、存在しない id と別のペアの id も飛ばす
      // （3 つとも docs/fidelity.md の「取消済み・約定済みの取消」節に記録した）。
      if (!r.success) continue;
      next = r.data.state;
      canceled.push(r.data.order);
    }
    if (canceled.length === 0) return err(ErrorCode.ORDER_NOT_FOUND);
    await store.commit(next);
    return ok({ orders: canceled.map(formatOrder) });
  });
};
