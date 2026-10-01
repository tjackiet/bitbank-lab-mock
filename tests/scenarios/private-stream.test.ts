import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCode } from "../../src/routes/envelope.ts";
import { buildServer } from "../../src/server/http.ts";
import { SessionStore } from "../../src/store/session.ts";
import type { PrivateStreamMessage } from "../../src/stream/events.ts";
import { DISCONNECT_CLOSE_CODE } from "../../src/stream/hub.ts";
import { buildOrder, buildState, candle } from "../engine/helpers.ts";
import { connectStream, setupBuildTestServer, stubFetchCandles } from "../routes/helpers.ts";

/**
 * 互換ルートと `/_control/` の操作が、private stream に何を流すかを端から端まで通す。
 *
 * 受入条件は `docs/plan-lab-mock.md` 3.4 の「注文を 2 本発注し、1 本を `/_control/` で約定、
 * もう 1 本を取消する」流れ。加えて、状態が変わる経路のうち**遷移関数の戻り値だけを見る
 * 発火では取りこぼすもの**（一括取消・market の tick）と、書き出しに失敗したときの流れ方
 * （`docs/plan-lab-mock.md` 16 節の決定 14）を見る。最後に、stream が切れる筋を利用側の
 * 規則（fail-closed・照合・再同期・単調性・終端の優先）の順に通す（同 18.2 の決定 35）。
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

/**
 * stream が**切れる**筋を、利用側の規則の順に通す（`docs/fidelity.md` の「private stream の切断」節）。
 *
 * - **fail-closed**: 切れて繋がらない間も、REST の照合（`orders_info`）と発注は通る
 * - **再同期**: 繋ぎ直した後は、未決の注文を照合してから受付を再開する。切れていた間の変化は、
 *   保留していなければ stream では届かないので、照合でしか拾えない
 * - **単調性・終端の優先**: 切る前に保留して繋ぎ直した後に release すると、照合で知った状態より
 *   古いスナップショットが遅れて届く。利用側はそれを捨てる
 *
 * ここで見るのはモックが**何を届けるか**で、利用側の規則そのものは実装しない。
 */
describe("private stream の切断のシナリオ", () => {
  const build = setupBuildTestServer();

  async function setup() {
    const { fastify } = await build(buildState(), {}, { fillMode: "manual", controlEnabled: true });
    const post = (url: string, payload?: Record<string, unknown>) =>
      fastify.inject({ method: "POST", url, ...(payload === undefined ? {} : { payload }) });
    /** REST の照合。利用側が stream の代わりに状態を確かめる口。 */
    const reconcile = async (ids: number[]) =>
      (await post("/v1/user/spot/orders_info", { pair: "btc_jpy", order_ids: ids })).json().data
        .orders as Array<Record<string, unknown>>;
    return { fastify, post, reconcile };
  }

  /** 注文の `status` と `executed_amount`。どのスナップショットかを読むのに使う。 */
  const snapshot = (o: Record<string, unknown> | undefined) => ({
    order_id: o?.order_id,
    status: o?.status,
    executed_amount: o?.executed_amount,
  });
  const orderSnapshots = (ms: PrivateStreamMessage[]) =>
    ms.filter((m) => m.message.method === "spot_order").map((m) => snapshot(param(m)));

  it("refuse → disconnect の間の約定と取消は、繋ぎ直した stream には現れず、照合で拾う（fail-closed → 照合 → 再同期）", async () => {
    const { fastify, post, reconcile } = await setup();
    const first = await connectStream(fastify);
    const idA = (await post("/v1/user/spot/order", buy(5_000_000, 0.002))).json().data.order_id;
    const idB = (await post("/v1/user/spot/order", buy(4_000_000))).json().data.order_id;
    await first.flush();
    expect(methods(first.take())).toEqual([
      "spot_order_new",
      "asset_update",
      "spot_order_new",
      "asset_update",
    ]);

    // 受け付けない状態を先に入れてから切る。この順なら、その間に繋ぎ直されない。
    expect((await post("/_control/stream/refuse")).json()).toEqual({ accepting: false });
    expect((await post("/_control/stream/disconnect")).json()).toEqual({ closed: 1 });
    expect((await first.closed).code).toBe(DISCONNECT_CLOSE_CODE);

    // 切れている間に、A が部分約定し、B を取り消す（取消は互換ルートからも通る）。
    expect((await post(`/_control/orders/${idA}/fill`, { amount: 0.001 })).statusCode).toBe(200);
    const cancel = await post("/v1/user/spot/cancel_order", { pair: "btc_jpy", order_id: idB });
    expect(cancel.json().success).toBe(1);

    // fail-closed の間: 繋ぎ直しは断られるが、REST の照合は通り、切れていた間の変化が見える。
    await expect(connectStream(fastify)).rejects.toThrow("Unexpected server response: 503");
    expect((await reconcile([idA, idB])).map(snapshot)).toEqual([
      { order_id: idA, status: "PARTIALLY_FILLED", executed_amount: "0.0010" },
      { order_id: idB, status: "CANCELED_UNFILLED", executed_amount: "0.0000" },
    ]);

    // 再同期: 繋ぎ直しても、切れていた間の変化は stream では届かない（保留していないので）。
    expect((await post("/_control/stream/accept")).json()).toEqual({ accepting: true });
    const again = await connectStream(fastify);
    await again.flush();
    expect(again.messages).toEqual([]);

    // 繋ぎ直した後の変化は届き、照合で知った状態から先へ進んだスナップショットになる。
    await post(`/_control/orders/${idA}/fill`);
    await again.flush();
    expect(methods(again.messages)).toEqual([
      "spot_order",
      "spot_trade",
      "asset_update",
      "asset_update",
    ]);
    expect(orderSnapshots(again.messages)).toEqual([
      { order_id: idA, status: "FULLY_FILLED", executed_amount: "0.0020" },
    ]);
    const { executed_at, is_just_triggered, ...streamed } = param(again.messages[0]);
    expect(streamed).toEqual((await reconcile([idA]))[0]);
    again.ws.terminate();
  });

  it("切る前に hold し、照合の後に release すると、照合より古いスナップショットが遅れて届く（単調性・終端の優先）", async () => {
    const { fastify, post, reconcile } = await setup();
    const first = await connectStream(fastify);
    const idA = (await post("/v1/user/spot/order", buy(5_000_000, 0.002))).json().data.order_id;
    await first.flush();
    first.take();

    await post("/_control/stream/hold");
    await post("/_control/stream/refuse");
    await post("/_control/stream/disconnect");
    expect((await first.closed).code).toBe(DISCONNECT_CLOSE_CODE);

    // 切れている間に半分ずつ 2 回約定する。接続は 0 本だが、保留中なので溜まる。
    await post(`/_control/orders/${idA}/fill`, { amount: 0.001 });
    await post(`/_control/orders/${idA}/fill`);
    const held = (await fastify.inject({ method: "GET", url: "/_control/stream/held" })).json();
    expect(held).toMatchObject({ holding: true, held: 8, accepting: false });

    // 照合では、もう終端（FULLY_FILLED）まで進んでいる。
    const reconciled = (await reconcile([idA]))[0];
    expect(snapshot(reconciled)).toEqual({
      order_id: idA,
      status: "FULLY_FILLED",
      executed_amount: "0.0020",
    });

    await post("/_control/stream/accept");
    const again = await connectStream(fastify);
    const res = await post("/_control/stream/release");
    expect(res.json()).toEqual({ sent: 8, omitted: [], clients: 1 });
    await again.flush();

    // 照合の後に、照合より古い PARTIALLY_FILLED（約定量も少ない）が届く。利用側は単調性と
    // 終端の優先でこれを捨て、続く FULLY_FILLED だけを採る。
    expect(orderSnapshots(again.messages)).toEqual([
      { order_id: idA, status: "PARTIALLY_FILLED", executed_amount: "0.0010" },
      { order_id: idA, status: "FULLY_FILLED", executed_amount: "0.0020" },
    ]);
    // 最後に届いたスナップショットは、照合の結果と一致する。
    const last = again.messages.filter((m) => m.message.method === "spot_order").at(-1);
    const { executed_at, is_just_triggered, ...streamed } = param(last);
    expect(streamed).toEqual(reconciled);
    expect(first.messages).toEqual([]);
    again.ws.terminate();
  });

  it("disconnect → refuse の逆の順だと、その間に繋ぎ直した接続が残り、stream は切れていない", async () => {
    const { fastify, post } = await setup();
    const first = await connectStream(fastify);
    expect((await post("/_control/stream/disconnect")).json()).toEqual({ closed: 1 });
    expect((await first.closed).code).toBe(DISCONNECT_CLOSE_CODE);

    // refuse を入れる前に、利用側がすぐ繋ぎ直す。
    const fast = await connectStream(fastify);
    expect((await post("/_control/stream/refuse")).json()).toEqual({ accepting: false });

    // refuse は今の接続を閉じないので、この接続には変化が届き続ける。
    await post("/v1/user/spot/order", buy(5_000_000));
    await fast.flush();
    expect(methods(fast.take())).toEqual(["spot_order_new", "asset_update"]);
    await expect(connectStream(fastify)).rejects.toThrow("Unexpected server response: 503");

    // 切るには disconnect をもう 1 度呼ぶ。
    expect((await post("/_control/stream/disconnect")).json()).toEqual({ closed: 1 });
    expect((await fast.closed).code).toBe(DISCONNECT_CLOSE_CODE);
    expect(fastify.privateStream.clientCount()).toBe(0);
  });
});
