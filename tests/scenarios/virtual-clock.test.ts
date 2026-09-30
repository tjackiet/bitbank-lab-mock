import { describe, expect, it } from "vitest";
import type { PrivateStreamMessage } from "../../src/stream/events.ts";
import { buildState, candle } from "../engine/helpers.ts";
import { connectStream, setupBuildTestServer } from "../routes/helpers.ts";

/**
 * 仮想時計（`BITBANK_MOCK_CLOCK=virtual`）で、互換ルートと `/_control/` が記録する時刻を
 * 端から端まで通す（`docs/plan-lab-mock.md` 17.2 の決定 24〜28、`docs/fidelity.md` の「仮想時計」節）。
 *
 * 利用側がこのモックで確かめたいのは、有効期限（**境界の時刻は有効に含む**）と JST の暦日の窓を、
 * **毎回同じ時刻で**踏むことである。だからここでは「だいたいその時刻」ではなく、
 * ミリ秒まで一致することを見る。
 *
 * 時計は**実時刻から十分に離した時刻**から始める。どこか 1 か所でも実時刻で記録すれば、
 * 必ず食い違って落ちる。
 */

/** 2020-02-03 13:05:06.789 JST。実時刻とは必ず食い違う。 */
const V0 = Date.parse("2020-02-03T04:05:06.789Z");
const iso = (ms: number) => new Date(ms).toISOString();

const LIMIT_BUY = { pair: "btc_jpy", side: "buy", type: "limit", price: 5_000_000, amount: 0.001 };

const param = (m: PrivateStreamMessage | undefined) =>
  m?.message.params[0] as Record<string, unknown>;

describe("仮想時計のシナリオ", () => {
  const build = setupBuildTestServer();

  async function setup(realNow?: () => number, candles = {}) {
    const r = await build(buildState({ lastTickAt: iso(V0) }), candles, {
      fillMode: "manual",
      controlEnabled: true,
      clockMode: "virtual",
      now: realNow,
    });
    const inject = r.fastify.inject.bind(r.fastify);
    const order = async (payload: object = LIMIT_BUY) =>
      (await inject({ method: "POST", url: "/v1/user/spot/order", payload })).json();
    const advance = async (advanceMs: number) => {
      const res = await inject({ method: "POST", url: "/_control/clock", payload: { advanceMs } });
      expect(res.statusCode).toBe(200);
    };
    const control = (url: string) => inject({ method: "POST", url: `/_control${url}` });
    const get = async (url: string) => (await inject({ method: "GET", url })).json();
    return { ...r, order, advance, control, get };
  }

  /**
   * 利用側の有効期限は「境界の時刻は有効に含む」。境界ちょうどと 1 ミリ秒後を分けて踏めることを、
   * 発注から取消・約定・拒否までの 4 つの時刻で見る。
   */
  it.each([
    ["境界ちょうど", 0],
    ["境界の 1 ミリ秒後", 1],
  ])("発注から 10 分の境界を狙って取消・約定・拒否できる（%s）", async (_label, delta) => {
    const { order, advance, control, get, fastify, store } = await setup();
    const expiresAt = V0 + 10 * 60_000;

    const placed = [await order(), await order(), await order()];
    expect(placed.map((p) => p.data.ordered_at)).toEqual([V0, V0, V0]);

    await advance(expiresAt + delta - V0);

    const canceled = (
      await fastify.inject({
        method: "POST",
        url: "/v1/user/spot/cancel_order",
        payload: { pair: "btc_jpy", order_id: 1 },
      })
    ).json();
    expect(canceled.data.canceled_at).toBe(expiresAt + delta);

    const filled = (await control("/orders/2/fill")).json();
    expect(filled.trade.executed_at).toBe(expiresAt + delta);

    expect((await control("/orders/3/reject")).statusCode).toBe(200);
    // 拒否の時刻は REST の応答に出ないので（`docs/fidelity.md` の「`/_control/`」節）、状態で見る。
    expect(store.state().orders[2]!.updatedAt).toBe(iso(expiresAt + delta));

    // 照会でも同じ値が見える（記録した時刻がそのまま出る）。
    const info = await get("/v1/user/spot/order?pair=btc_jpy&order_id=1");
    expect(info.data.canceled_at).toBe(expiresAt + delta);
    const trades = await get("/v1/user/spot/trade_history?pair=btc_jpy");
    expect(trades.data.trades.map((t: { executed_at: number }) => t.executed_at)).toEqual([
      expiresAt + delta,
    ]);
  });

  /**
   * JST の暦日の窓を何日ぶんも進められる（決定 27）。暦日の境目（JST 0 時 = UTC 15 時）の
   * 直前と直後に発注し、`ordered_at` がちょうどその値になることを見る。
   */
  it("JST の暦日の境目をまたいで、2 日先まで進めて発注できる", async () => {
    const { order, advance } = await setup();
    // V0 の翌々日の JST 0 時。V0 は 2020-02-03 13:05 JST なので 2020-02-05 00:00 JST。
    const midnight = Date.parse("2020-02-04T15:00:00.000Z");
    // 1 回で 24 時間までしか進めないので、24 時間ずつ刻んでから残りを進める。
    await advance(24 * 60 * 60 * 1000);
    await advance(midnight - 1 - (V0 + 24 * 60 * 60 * 1000));
    expect((await order()).data.ordered_at).toBe(midnight - 1);
    await advance(1);
    expect((await order()).data.ordered_at).toBe(midnight);
  });

  it("private stream の executed_at と約定の時刻が仮想時刻になる", async () => {
    const { order, advance, control, fastify } = await setup();
    const stream = await connectStream(fastify);
    await order();
    await advance(1_234);
    await control("/orders/1/fill");
    await stream.flush();

    const byMethod = (m: string) => stream.messages.filter((x) => x.message.method === m);
    const [orderNew] = byMethod("spot_order_new");
    expect(param(orderNew).ordered_at).toBe(V0);
    // 約定の無い注文の executed_at は 0（`docs/fidelity.md` の「private stream の注文ペイロード」節）。
    expect(param(orderNew).executed_at).toBe(0);
    const [filledOrder] = byMethod("spot_order");
    expect(param(filledOrder).status).toBe("FULLY_FILLED");
    expect(param(filledOrder).executed_at).toBe(V0 + 1_234);
    const [trade] = byMethod("spot_trade");
    expect(param(trade).executed_at).toBe(V0 + 1_234);
  });

  it("tick の約定の executed_at も時計と同じ値で届く", async () => {
    const { order, fastify, store } = await setup();
    const stream = await connectStream(fastify);
    await order();
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/tick",
      payload: { pair: "btc_jpy", price: 4_900_000 },
    });
    expect(res.statusCode).toBe(200);
    await stream.flush();
    const trade = stream.messages.find((m) => m.message.method === "spot_trade");
    expect(param(trade).executed_at).toBe(V0 + 60_000);
    expect(store.now()).toBe(V0 + 60_000);
  });

  /**
   * 決定 26: 時計を進めない限り、続けて出した注文は同じ時刻になる。時刻で絞り込む応答は
   * 時刻で並べ替えず生成順のまま返すので、同じ時刻どうしは id 順（`trade_history` の既定の
   * `desc` なら id の逆順）に並ぶ（`docs/fidelity.md` の「active_orders の絞り込み」節・
   * 「trade_history の絞り込み」節）。
   */
  it("同じ時刻の記録は、active_orders と trade_history の since / end で id 順に並ぶ", async () => {
    const { order, advance, control, get } = await setup();
    for (let i = 0; i < 4; i++) await order();

    const active = await get(`/v1/user/spot/active_orders?pair=btc_jpy&since=${V0}&end=${V0}`);
    expect(active.data.orders.map((o: { order_id: number }) => o.order_id)).toEqual([1, 2, 3, 4]);
    expect(active.data.orders.every((o: { ordered_at: number }) => o.ordered_at === V0)).toBe(true);

    const E = V0 + 1_000;
    await advance(1_000);
    // 生成順と id 順を揃えたまま、約定は id の逆順に起こす（trade id は約定の順に振られる）。
    for (const id of [4, 3, 2, 1])
      expect((await control(`/orders/${id}/fill`)).statusCode).toBe(200);

    const tradesAt = async (query: string) =>
      (
        await get(`/v1/user/spot/trade_history?pair=btc_jpy&since=${E}&end=${E}${query}`)
      ).data.trades.map((t: { trade_id: number; order_id: number; executed_at: number }) => [
        t.trade_id,
        t.order_id,
        t.executed_at,
      ]);
    expect(await tradesAt("")).toEqual([
      [4, 1, E],
      [3, 2, E],
      [2, 3, E],
      [1, 4, E],
    ]);
    expect(await tradesAt("&order=asc")).toEqual([
      [1, 4, E],
      [2, 3, E],
      [3, 2, E],
      [4, 1, E],
    ]);
    // 境界の外（1 ミリ秒ずらす）には入らない。
    expect(
      (await get(`/v1/user/spot/trade_history?pair=btc_jpy&since=${E + 1}`)).data.trades,
    ).toEqual([]);
    expect(
      (await get(`/v1/user/spot/active_orders?pair=btc_jpy&end=${V0 - 1}`)).data.orders,
    ).toEqual([]);
  });

  /**
   * 成行は価格を実時刻の窓で取り、記録する時刻だけを仮想にする（`docs/fidelity.md` の
   * 「仮想時計」節）。仮想時刻を基準に窓を切ると、時計を実時刻より先へ進めた途端に足が無くなり、
   * 常に `70001` で断られる。足は実時刻の窓（実時刻 − 5 分 〜 実時刻）の中にだけ置く。
   */
  it("成行は実時刻の窓で価格を取り、ordered_at と約定時刻は仮想時刻", async () => {
    const REAL = Date.parse("2026-09-30T00:00:00.000Z");
    const { order, store } = await setup(() => REAL, {
      btc_jpy: [candle(REAL - 60_000, 4_000_000, 4_000_000, 4_000_000, 4_000_000)],
    });
    const placed = await order({ pair: "btc_jpy", side: "buy", type: "market", amount: 0.001 });
    expect(placed.success).toBe(1);
    expect(placed.data.ordered_at).toBe(V0);
    expect(store.state().trades.map((t) => [t.price, t.executedAt])).toEqual([
      [4_000_000, iso(V0)],
    ]);
    expect(store.candlesHealth().lastSuccessAt).toBe(iso(REAL));
  });
});
