import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCode } from "../../src/routes/envelope.ts";
import { buildServer } from "../../src/server/http.ts";
import { SessionStore } from "../../src/store/session.ts";
import type { PrivateStreamMessage } from "../../src/stream/events.ts";
import { buildOrder, buildState, candle } from "../engine/helpers.ts";
import { connectStream, setupBuildTestServer, stubFetchCandles } from "../routes/helpers.ts";

/**
 * 互換ルートと `/_control/` の操作が、private stream に何を流すかを端から端まで通す。
 *
 * 受入条件は `docs/plan-lab-mock.md` 3.4 の「注文を 2 本発注し、1 本を `/_control/` で約定、
 * もう 1 本を取消する」流れ。加えて、状態が変わる経路のうち**遷移関数の戻り値だけを見る
 * 発火では取りこぼすもの**（一括取消・market の tick）と、書き出しに失敗したときの流れ方
 * （`docs/plan-lab-mock.md` 16 節の決定 14）を見る。
 */

const buy = (price: number, amount = 0.001) => ({
  pair: "btc_jpy",
  side: "buy",
  type: "limit",
  price,
  amount,
});

const methods = (ms: PrivateStreamMessage[]) => ms.map((m) => m.message.method);
const param = (m: PrivateStreamMessage | undefined) =>
  m?.message.params[0] as Record<string, unknown>;

describe("private stream のシナリオ", () => {
  const build = setupBuildTestServer();

  it("2 本発注し、1 本を control で約定、もう 1 本を取消す（受入条件）", async () => {
    const { fastify } = await build(buildState(), {}, { fillMode: "manual", controlEnabled: true });
    const stream = await connectStream(fastify);

    const a = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: buy(5_000_000),
    });
    const b = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: buy(4_000_000),
    });
    const idA = a.json().data.order_id;
    const idB = b.json().data.order_id;
    await stream.flush();
    expect(methods(stream.messages)).toEqual([
      "spot_order_new",
      "asset_update",
      "spot_order_new",
      "asset_update",
    ]);
    stream.take();

    await fastify.inject({ method: "POST", url: `/_control/orders/${idA}/fill`, payload: {} });
    await stream.flush();
    const fill = stream.take();
    expect(methods(fill)).toEqual(["spot_order", "spot_trade", "asset_update", "asset_update"]);
    expect(param(fill[0])).toMatchObject({ order_id: idA, status: "FULLY_FILLED" });
    expect(param(fill[1])).toMatchObject({ order_id: idA });

    await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/cancel_order",
      payload: { pair: "btc_jpy", order_id: idB },
    });
    await stream.flush();
    const cancel = stream.take();
    expect(methods(cancel)).toEqual(["spot_order", "asset_update"]);
    expect(param(cancel[0])).toMatchObject({ order_id: idB, status: "CANCELED_UNFILLED" });

    // stream が最後に伝えた見え方は、同じ時点の REST と一致する。
    const restA = (
      await fastify.inject({
        method: "GET",
        url: `/v1/user/spot/order?pair=btc_jpy&order_id=${idA}`,
      })
    ).json().data;
    const { is_just_triggered, executed_at, ...streamedA } = param(fill[0]);
    expect(streamedA).toEqual(restA);
    expect(is_just_triggered).toBe(false);

    const trades = (
      await fastify.inject({ method: "GET", url: "/v1/user/spot/trade_history?pair=btc_jpy" })
    ).json().data.trades;
    expect(trades).toEqual([param(fill[1])]);
    expect(executed_at).toBe(trades[0].executed_at);

    const assets = (await fastify.inject({ method: "GET", url: "/v1/user/assets" })).json().data
      .assets as Array<Record<string, unknown>>;
    const lastJpy = param(cancel[1]);
    const restJpy = assets.find((x) => x.asset === "jpy");
    expect(lastJpy).toEqual({
      asset: "jpy",
      amountPrecision: restJpy?.amount_precision,
      freeAmount: restJpy?.free_amount,
      lockedAmount: restJpy?.locked_amount,
      onhandAmount: restJpy?.onhand_amount,
      withdrawingAmount: restJpy?.withdrawing_amount,
    });
    stream.ws.terminate();
  });

  it("一括取消は 1 回の書き込みでも、取り消した注文ごとに spot_order が流れる", async () => {
    const { fastify } = await build(buildState(), {}, { fillMode: "manual" });
    const ids: number[] = [];
    for (const price of [5_000_000, 4_000_000]) {
      const r = await fastify.inject({
        method: "POST",
        url: "/v1/user/spot/order",
        payload: buy(price),
      });
      ids.push(r.json().data.order_id);
    }
    const stream = await connectStream(fastify);
    await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/cancel_orders",
      payload: { pair: "btc_jpy", order_ids: ids },
    });
    await stream.flush();
    expect(methods(stream.messages)).toEqual(["spot_order", "spot_order", "asset_update"]);
    expect(stream.messages.slice(0, 2).map((m) => param(m).order_id)).toEqual(ids);
    stream.ws.terminate();
  });

  it("成行は spot_order_new が 1 通、FULLY_FILLED で届く", async () => {
    const nowMs = Date.now();
    const { fastify } = await build(
      buildState(),
      { btc_jpy: [candle(nowMs - 60_000, 5_000_000, 5_000_000, 5_000_000, 5_000_000)] },
      { fillMode: "manual" },
    );
    const stream = await connectStream(fastify);
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", side: "buy", type: "market", amount: 0.001 },
    });
    expect(res.json().success).toBe(1);
    await stream.flush();
    expect(methods(stream.messages)).toEqual([
      "spot_order_new",
      "spot_trade",
      "asset_update",
      "asset_update",
    ]);
    expect(param(stream.messages[0])).toMatchObject({ type: "market", status: "FULLY_FILLED" });
    stream.ws.terminate();
  });

  /**
   * market モードでは、**読み取りの要求が約定を起こし、そのイベントが流れる**
   * （`docs/plan-lab-mock.md` 16 節の決定 13）。状態と stream を食い違わせないための選択で、
   * 代償は「誰も読まない限り約定もイベントも起きない」ことである。
   */
  it("market モードでは読み取りの要求が起こした約定も流れる", async () => {
    const nowMs = Date.now();
    const from = new Date(nowMs - 60_000).toISOString();
    const state = buildState({
      lastTickAt: from,
      orders: [buildOrder({ price: 5_000_000, orderedAt: from, updatedAt: from })],
    });
    const candles = {
      btc_jpy: [candle(nowMs - 30_000, 5_000_000, 5_000_000, 4_900_000, 4_950_000)],
    };
    const { fastify } = await build(state, candles, { fillMode: "market" });
    const stream = await connectStream(fastify);
    await stream.flush();
    expect(stream.messages).toEqual([]);

    await fastify.inject({ method: "GET", url: "/v1/user/assets" });
    await stream.flush();
    expect(methods(stream.messages)).toEqual([
      "spot_order",
      "spot_trade",
      "asset_update",
      "asset_update",
    ]);
    expect(param(stream.messages[0])).toMatchObject({ order_id: 1, status: "FULLY_FILLED" });
    stream.ws.terminate();
  });
});

describe("private stream と書き出しの失敗", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  /**
   * 書き出しの失敗は実際に起こす（状態ファイルのパスをディレクトリにすると `rename` が
   * `EISDIR` で落ちる）。`tests/server/degraded.test.ts` と同じ作り方。
   */
  it("失敗の引き金になった要求のイベントは流れ、以後は状態が動かないので何も流れない", async () => {
    dir = await mkdtemp(join(tmpdir(), "bitbank-mock-stream-degraded-"));
    const path = join(dir, "state.json");
    await mkdir(path, { recursive: true });
    const store = new SessionStore(buildState(), {
      path,
      fillMode: "manual",
      persistFailureMode: "degrade",
      fetchCandles: stubFetchCandles({}),
    });
    const fastify = await buildServer({ store, logger: false, streamAssetKeys: "camel" });
    try {
      const stream = await connectStream(fastify);

      // HTTP は失敗（70001）だが、メモリには注文が残り、stream はそのメモリに従う。
      const first = await fastify.inject({
        method: "POST",
        url: "/v1/user/spot/order",
        payload: buy(5_000_000),
      });
      expect(first.json()).toEqual({ success: 0, data: { code: ErrorCode.INTERNAL } });
      await stream.flush();
      expect(methods(stream.take())).toEqual(["spot_order_new", "asset_update"]);

      // 劣化後の変更は断られ、状態が動かないので何も流れない。
      const second = await fastify.inject({
        method: "POST",
        url: "/v1/user/spot/order",
        payload: buy(4_000_000),
      });
      expect(second.json()).toEqual({ success: 0, data: { code: ErrorCode.INTERNAL } });
      await stream.flush();
      expect(stream.messages).toEqual([]);

      // 読み取りは生きていて、stream が伝えた注文を REST からも引ける。
      const order = await fastify.inject({
        method: "GET",
        url: "/v1/user/spot/order?pair=btc_jpy&order_id=1",
      });
      expect(order.json().data.status).toBe("UNFILLED");
      stream.ws.terminate();
    } finally {
      await fastify.close();
    }
  });
});
