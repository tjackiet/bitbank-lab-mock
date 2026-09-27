import { describe, expect, it } from "vitest";
import type { PaperState } from "../../src/engine/state.ts";
import { cancelOrder, fillOrder, placeOrder } from "../../src/engine/transitions.ts";
import { formatAssets, formatOrder, formatTrade } from "../../src/routes/format.ts";
import { type PrivateStreamMessage, stateChangeMessages } from "../../src/stream/events.ts";
import { buildOrder, buildState, buildTrade } from "../engine/helpers.ts";
import {
  flatShape,
  OFFICIAL_ASSET_UPDATE_CAMEL_FIELDS,
  OFFICIAL_ASSET_UPDATE_SNAKE_FIELDS,
  OFFICIAL_SPOT_TRADE_FIELDS,
  OFFICIAL_STREAM_ORDER_STATUSES,
  streamOrderShape,
} from "../routes/official-fields.ts";

const T = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:01:00.000Z";
const T2 = "2026-01-01T00:02:00.000Z";
const FEE = 0.0012;
const OPTS = { feeRate: FEE, assetKeys: "camel" as const };

/** 遷移の成功を取り出す。失敗したらテストの前提が崩れているので落とす。 */
function must<T>(r: { success: true; data: T } | { success: false; error: string }): T {
  if (!r.success) throw new Error(r.error);
  return r.data;
}

const methods = (ms: PrivateStreamMessage[]) => ms.map((m) => m.message.method);
const params = (m: PrivateStreamMessage | undefined) =>
  m?.message.params[0] as Record<string, unknown>;

/** 1 本の指値買いを置いた状態。 */
function withLimitBuy(base: PaperState = buildState()) {
  return must(
    placeOrder(
      base,
      { pair: "btc_jpy", side: "buy", type: "limit", amount: 0.001, price: 5_000_000 },
      T,
      undefined,
      FEE,
    ),
  );
}

describe("stateChangeMessages: 注文", () => {
  it("指値の発注は spot_order_new 1 通と、拘束が動いた資産の asset_update", () => {
    const prev = buildState();
    const { state: next } = withLimitBuy(prev);
    const ms = stateChangeMessages(prev, next, OPTS);
    expect(methods(ms)).toEqual(["spot_order_new", "asset_update"]);

    const order = params(ms[0]);
    const shape = streamOrderShape(order, { type: "limit", canceled: false });
    expect(shape.actual).toEqual(shape.expected);
    expect(order.status).toBe("UNFILLED");
    expect(order.is_just_triggered).toBe(false);
    // 英日どちらの表も executed_at を number（省略不可）と書くので、約定が無くても 0 で出す。
    expect(order.executed_at).toBe(0);
    expect(OFFICIAL_STREAM_ORDER_STATUSES).toContain(order.status);
  });

  it("注文ペイロードは REST の注文オブジェクトに 2 つ足しただけ（共通部分は同じ値）", () => {
    const prev = buildState();
    const { state: next, order } = withLimitBuy(prev);
    const streamed = params(stateChangeMessages(prev, next, OPTS)[0]);
    const { is_just_triggered, executed_at, ...rest } = streamed;
    expect(is_just_triggered).toBe(false);
    expect(executed_at).toBe(0);
    expect(rest).toEqual(formatOrder(order));
  });

  it("部分約定は spot_order（PARTIALLY_FILLED）と spot_trade と資産。注文 → 約定 → 資産の順", () => {
    const { state: prev, order } = withLimitBuy();
    const { state: next, trade } = must(fillOrder(prev, order.id, 5_000_000, 0.0004, T1, FEE));
    const ms = stateChangeMessages(prev, next, OPTS);
    expect(methods(ms)).toEqual(["spot_order", "spot_trade", "asset_update", "asset_update"]);

    const o = params(ms[0]);
    const shape = streamOrderShape(o, { type: "limit", canceled: false });
    expect(shape.actual).toEqual(shape.expected);
    expect(o.status).toBe("PARTIALLY_FILLED");
    expect(o.executed_at).toBe(Date.parse(T1));

    // spot_trade は REST の trade_history と同じ整形。
    const t = params(ms[1]);
    const tShape = flatShape(t, OFFICIAL_SPOT_TRADE_FIELDS);
    expect(tShape.actual).toEqual(tShape.expected);
    expect(t).toEqual(trade && formatTrade(trade));

    expect(ms.slice(2).map((m) => params(m).asset)).toEqual(["jpy", "btc"]);
  });

  it("成行は 1 回の差し替えで置かれて埋まるので、spot_order_new が 1 通だけ FULLY_FILLED で届く", () => {
    const prev = buildState();
    const { state: next } = must(
      placeOrder(
        prev,
        { pair: "btc_jpy", side: "buy", type: "market", amount: 0.001 },
        T,
        5_000_000,
        FEE,
      ),
    );
    const ms = stateChangeMessages(prev, next, OPTS);
    expect(methods(ms)).toEqual(["spot_order_new", "spot_trade", "asset_update", "asset_update"]);
    const o = params(ms[0]);
    const shape = streamOrderShape(o, { type: "market", canceled: false });
    expect(shape.actual).toEqual(shape.expected);
    expect(o.status).toBe("FULLY_FILLED");
    expect(o.executed_at).toBe(Date.parse(T));
  });

  it("取消は spot_order（canceled_at 付き）と、拘束が外れた資産だけ。約定は流れない", () => {
    const { state: prev, order } = withLimitBuy();
    const { state: next } = must(cancelOrder(prev, order.id, T1));
    const ms = stateChangeMessages(prev, next, OPTS);
    expect(methods(ms)).toEqual(["spot_order", "asset_update"]);
    const o = params(ms[0]);
    const shape = streamOrderShape(o, { type: "limit", canceled: true });
    expect(shape.actual).toEqual(shape.expected);
    expect(o.status).toBe("CANCELED_UNFILLED");
    expect(o.canceled_at).toBe(Date.parse(T1));
  });

  it("n 件を畳んだ一括取消でも、注文ごとに 1 通ずつ発注順に流れる", () => {
    const a = withLimitBuy();
    const b = withLimitBuy(a.state);
    const prev = b.state;
    const folded = must(cancelOrder(must(cancelOrder(prev, b.order.id, T1)).state, a.order.id, T1));
    const ms = stateChangeMessages(prev, folded.state, OPTS);
    expect(methods(ms)).toEqual(["spot_order", "spot_order", "asset_update"]);
    expect(ms.slice(0, 2).map((m) => params(m).order_id)).toEqual([1, 2]);
  });

  it("executed_at は記録順ではなく最も遅い約定時刻", () => {
    const order = buildOrder({
      id: "1",
      startAmount: 0.002,
      executedAmount: 0.001,
      executedNotional: 5_000,
      status: "PARTIALLY_FILLED",
    });
    const prev = buildState({
      balances: { jpy: 10_000_000, btc: 0.001 },
      orders: [order],
      trades: [buildTrade({ tradeId: "1", orderId: "1", executedAt: T2 })],
    });
    // 過去の足を流し直すと、後から記録した約定の時刻のほうが早くなる。
    const { state: next } = must(fillOrder(prev, "1", 5_000_000, 0.001, T1, FEE));
    const o = params(stateChangeMessages(prev, next, OPTS)[0]);
    expect(o.status).toBe("FULLY_FILLED");
    expect(o.executed_at).toBe(Date.parse(T2));
  });
});

describe("stateChangeMessages: 何も流さない差し替え", () => {
  it("時計だけを動かした差し替えは何も流さない", () => {
    const { state: prev } = withLimitBuy();
    const next = { ...prev, lastTickAt: T2, updatedAt: T2 };
    expect(stateChangeMessages(prev, next, OPTS)).toEqual([]);
  });

  it("参照が変わっても wire 上の見え方が同じなら流さない", () => {
    const { state: prev } = withLimitBuy();
    const clone = JSON.parse(JSON.stringify(prev)) as PaperState;
    expect(stateChangeMessages(prev, clone, OPTS)).toEqual([]);
  });

  it("消えた注文と約定については何も送らない（公式に表すメソッドが無い）", () => {
    const { state: filled } = must(
      placeOrder(
        buildState(),
        { pair: "btc_jpy", side: "buy", type: "market", amount: 0.001 },
        T,
        5_000_000,
        FEE,
      ),
    );
    const next = { ...filled, orders: [], trades: [] };
    expect(methods(stateChangeMessages(filled, next, OPTS))).toEqual([]);
  });
});

describe("stateChangeMessages: 資産", () => {
  it("値は GET /v1/user/assets と同じ文字列で、綴りは camel / snake を選べる", () => {
    const prev = buildState();
    const { state: next } = withLimitBuy(prev);
    const jpy = formatAssets(next, FEE).assets.find((a) => a.asset === "jpy");

    const camel = params(stateChangeMessages(prev, next, OPTS).at(-1));
    const camelShape = flatShape(camel, OFFICIAL_ASSET_UPDATE_CAMEL_FIELDS);
    expect(camelShape.actual).toEqual(camelShape.expected);
    expect(camel).toEqual({
      asset: "jpy",
      amountPrecision: jpy?.amount_precision,
      freeAmount: jpy?.free_amount,
      lockedAmount: jpy?.locked_amount,
      onhandAmount: jpy?.onhand_amount,
      withdrawingAmount: jpy?.withdrawing_amount,
    });

    const snake = params(
      stateChangeMessages(prev, next, { feeRate: FEE, assetKeys: "snake" }).at(-1),
    );
    const snakeShape = flatShape(snake, OFFICIAL_ASSET_UPDATE_SNAKE_FIELDS);
    expect(snakeShape.actual).toEqual(snakeShape.expected);
    expect(snake.free_amount).toBe(jpy?.free_amount);
  });

  it("拘束額は渡した料率で計算する（REST の locked_amount と同じ率）", () => {
    const prev = buildState();
    const { state: next } = withLimitBuy(prev);
    const zero = params(stateChangeMessages(prev, next, { feeRate: 0, assetKeys: "snake" }).at(-1));
    expect(zero.locked_amount).toBe("5000.0000");
  });

  it("一覧から消えた資産は 0 として送り、もともと 0 だったものは送らない", () => {
    const prev = buildState({ balances: { jpy: 1_000, doge: 5, dust: 0 } });
    const next = { ...prev, balances: { jpy: 1_000 } };
    const ms = stateChangeMessages(prev, next, { feeRate: FEE, assetKeys: "snake" });
    expect(ms.map((m) => params(m))).toEqual([
      {
        asset: "doge",
        amount_precision: 8,
        free_amount: "0.00000000",
        locked_amount: "0.00000000",
        onhand_amount: "0.00000000",
        withdrawing_amount: "0.00000000",
      },
    ]);
  });
});

describe("stateChangeMessages: メッセージの形", () => {
  it("どのメッセージも { message: { method, params: [1 要素] } }", () => {
    const prev = buildState();
    const { state: next } = must(
      placeOrder(
        prev,
        { pair: "btc_jpy", side: "buy", type: "market", amount: 0.001 },
        T,
        5_000_000,
        FEE,
      ),
    );
    for (const m of stateChangeMessages(prev, next, OPTS)) {
      expect(Object.keys(m)).toEqual(["message"]);
      expect(Object.keys(m.message).sort()).toEqual(["method", "params"]);
      expect(m.message.params).toHaveLength(1);
    }
  });
});
