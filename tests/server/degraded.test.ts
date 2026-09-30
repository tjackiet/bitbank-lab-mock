import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadState } from "../../src/engine/persist.ts";
import type { PaperState } from "../../src/engine/state.ts";
import { persistFailureMode } from "../../src/server/config.ts";
import type { PersistFailureMode } from "../../src/server/degraded.ts";
import {
  assertRouteClassified,
  MUTATING_ROUTES,
  NON_PERSISTING_CONTROL_ROUTES,
  passesWhileDegraded,
  READ_ROUTES,
  routeKey,
} from "../../src/server/degraded.ts";
import { buildServer } from "../../src/server/http.ts";
import { SessionStore } from "../../src/store/session.ts";
import { buildOrder, buildState, buildTrade, candle } from "../engine/helpers.ts";
import { connectStream, stubFetchCandles } from "../routes/helpers.ts";

const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

/** 発注済み・一部約定済みの状態。劣化中も読み取りが中身を返すことを見るために使う。 */
function seededState(): PaperState {
  return buildState({
    balances: { jpy: 100_000_000, btc: 0.001 },
    orders: [
      buildOrder({ id: "1", status: "UNFILLED", startAmount: 0.002 }),
      buildOrder({
        id: "2",
        status: "FULLY_FILLED",
        startAmount: 0.001,
        executedAmount: 0.001,
        executedNotional: 5_000,
      }),
    ],
    trades: [buildTrade({ tradeId: "1", orderId: "2" })],
  });
}

describe("劣化モード（persist に失敗した後）", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bitbank-mock-degraded-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * 書き出しが必ず失敗する store でサーバを建てる。状態ファイルのパスをディレクトリに
   * すると `rename` が `EISDIR` で落ちる（モックしない）。
   */
  async function buildDegradable(
    opts: {
      state?: PaperState;
      mode?: PersistFailureMode;
      fillMode?: "manual" | "market";
      candles?: Parameters<typeof stubFetchCandles>[0];
    } = {},
  ) {
    const path = join(dir, `s${Math.random().toString(36).slice(2, 8)}`, "state.json");
    await mkdir(path, { recursive: true });
    const store = new SessionStore(opts.state ?? seededState(), {
      path,
      fillMode: opts.fillMode ?? "manual",
      persistFailureMode: opts.mode ?? "degrade",
      feeRate: 0,
      fetchCandles: stubFetchCandles(opts.candles ?? {}),
    });
    const fastify = await buildServer({ store, logger: false, controlEnabled: true });
    return { fastify, store, close: () => fastify.close() };
  }

  /** 劣化させる（書き込みを 1 回失敗させる）。 */
  async function degrade(store: SessionStore): Promise<void> {
    await store.persist();
    expect(store.persistHealth().lastError).not.toBeNull();
  }

  // --- 完了条件 1: 状態を変える要求が全部断られる ---

  const MUTATING_REQUESTS: Array<{
    name: string;
    method: "POST";
    url: string;
    payload: Record<string, unknown>;
  }> = [
    {
      name: "POST /v1/user/spot/order",
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", side: "buy", type: "limit", price: 5_000_000, amount: 0.001 },
    },
    {
      name: "POST /v1/user/spot/cancel_order",
      method: "POST",
      url: "/v1/user/spot/cancel_order",
      payload: { pair: "btc_jpy", order_id: 1 },
    },
    {
      name: "POST /v1/user/spot/cancel_orders",
      method: "POST",
      url: "/v1/user/spot/cancel_orders",
      payload: { pair: "btc_jpy", order_ids: [1] },
    },
    { name: "POST /_control/reset", method: "POST", url: "/_control/reset", payload: {} },
    {
      name: "POST /_control/tick",
      method: "POST",
      url: "/_control/tick",
      payload: { pair: "btc_jpy", price: 4_000_000 },
    },
    { name: "POST /_control/clock", method: "POST", url: "/_control/clock", payload: {} },
    {
      name: "POST /_control/orders/:order_id/fill",
      method: "POST",
      url: "/_control/orders/1/fill",
      payload: {},
    },
    // seededState() の注文 1 は UNFILLED なので、劣化していなければ REJECTED になる。
    {
      name: "POST /_control/orders/:order_id/reject",
      method: "POST",
      url: "/_control/orders/1/reject",
      payload: {},
    },
  ];

  it.each(MUTATING_REQUESTS)("劣化中は $name を断る", async ({ method, url, payload }) => {
    const { fastify, store, close } = await buildDegradable();
    try {
      await degrade(store);
      const before = JSON.stringify(store.state());

      const res = await fastify.inject({ method, url, payload });

      if (url.startsWith("/_control/")) {
        // control は bitbank API に無いので素の JSON + 503。
        expect(res.statusCode).toBe(503);
        expect(res.json()).toEqual({ error: "PERSIST_DEGRADED" });
      } else {
        // 互換ルートは封筒 + INTERNAL(70001)。
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ success: 0, data: { code: 70001 } });
      }
      // 断ったのだから状態は 1 バイトも動いていない。
      expect(JSON.stringify(store.state())).toBe(before);
    } finally {
      await close();
    }
  });

  // --- 完了条件 2（これが完了条件）: 読み取りが全部 200 でメモリの状態を返す ---

  it("劣化中も読み取りは全部 200 で、メモリの状態を返す", async () => {
    const { fastify, store, close } = await buildDegradable();
    try {
      await degrade(store);
      const memory = store.state();

      const order = await fastify.inject({
        method: "GET",
        url: "/v1/user/spot/order?pair=btc_jpy&order_id=1",
      });
      expect(order.statusCode).toBe(200);
      expect(order.json().success).toBe(1);
      expect(String(order.json().data.order_id)).toBe("1");

      const ordersInfo = await fastify.inject({
        method: "POST",
        url: "/v1/user/spot/orders_info",
        payload: { pair: "btc_jpy", order_ids: [1, 2] },
      });
      expect(ordersInfo.statusCode).toBe(200);
      expect(ordersInfo.json().success).toBe(1);
      expect(ordersInfo.json().data.orders).toHaveLength(2);

      const active = await fastify.inject({
        method: "GET",
        url: "/v1/user/spot/active_orders?pair=btc_jpy",
      });
      expect(active.statusCode).toBe(200);
      expect(active.json().success).toBe(1);
      expect(active.json().data.orders).toHaveLength(1);

      const trades = await fastify.inject({
        method: "GET",
        url: "/v1/user/spot/trade_history?pair=btc_jpy",
      });
      expect(trades.statusCode).toBe(200);
      expect(trades.json().success).toBe(1);
      expect(trades.json().data.trades).toHaveLength(1);

      const assets = await fastify.inject({ method: "GET", url: "/v1/user/assets" });
      expect(assets.statusCode).toBe(200);
      expect(assets.json().success).toBe(1);

      // private stream の 2 経路も読み取り。接続は断らない（状態が動かないので何も流れない）。
      const subscribe = await fastify.inject({ method: "GET", url: "/v1/user/subscribe" });
      expect(subscribe.statusCode).toBe(200);
      expect(subscribe.json().success).toBe(1);
      const stream = await connectStream(fastify);
      expect(fastify.privateStream.clientCount()).toBe(1);
      stream.ws.terminate();

      // シナリオの読み出し口。ここから状態ファイルへ書き戻して再起動するのが復帰手順。
      const state = await fastify.inject({ method: "GET", url: "/_control/state" });
      expect(state.statusCode).toBe(200);
      expect(state.json()).toEqual({
        ...memory,
        persist: store.persistHealth(),
        candles: store.candlesHealth(),
      });
      expect(state.json().persist.lastError).not.toBeNull();
      // 劣化中は tick が丸ごと抜けるので足も取りに行かない（取得の失敗ではない）。
      expect(state.json().candles.lastError).toBeNull();
    } finally {
      await close();
    }
  });

  /**
   * 状態ファイルに書かない control の口（private stream の保留・再送）は劣化中も通す。
   * 劣化の前に溜めたもの——劣化の引き金になった `70001` の要求のイベントも含む——を
   * 取り出せないと、復帰の手順（再起動）でその回の stream の実験が消えるため。
   */
  it("劣化中も hold / held / release は通り、劣化の引き金になった要求のイベントも取り出せる", async () => {
    const { fastify, store, close } = await buildDegradable({ state: buildState() });
    try {
      const stream = await connectStream(fastify);
      const hold = await fastify.inject({ method: "POST", url: "/_control/stream/hold" });
      expect(hold.statusCode).toBe(200);

      // この発注の書き出しが失敗して劣化する。応答は 70001 だが、メモリと保留には残る。
      const order = await fastify.inject({
        method: "POST",
        url: "/v1/user/spot/order",
        payload: { pair: "btc_jpy", side: "buy", type: "limit", price: 5_000_000, amount: 0.001 },
      });
      expect(order.json()).toEqual({ success: 0, data: { code: 70001 } });
      expect(store.isDegraded()).toBe(true);

      const held = await fastify.inject({ method: "GET", url: "/_control/stream/held" });
      expect(held.statusCode).toBe(200);
      expect(held.json().held).toBe(2);
      // 劣化してから保留し直しても（既に保留中なので何もしないが）断られない。
      const again = await fastify.inject({ method: "POST", url: "/_control/stream/hold" });
      expect(again.statusCode).toBe(200);

      const release = await fastify.inject({ method: "POST", url: "/_control/stream/release" });
      expect(release.statusCode).toBe(200);
      expect(release.json()).toEqual({ sent: 2, omitted: [], clients: 1 });
      await stream.flush();
      expect(stream.methods()).toEqual(["spot_order_new", "asset_update"]);
      stream.ws.terminate();
    } finally {
      await close();
    }
  });

  it("劣化中に読み出した /_control/state を書き戻して読み込める（復帰手順）", async () => {
    const { fastify, store, close } = await buildDegradable();
    try {
      await degrade(store);
      const res = await fastify.inject({ method: "GET", url: "/_control/state" });
      const path = join(dir, "recovered.json");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, JSON.stringify(res.json(), null, 2));
      expect(await loadState(path)).toEqual({ success: true, data: store.state() });
    } finally {
      await close();
    }
  });

  // --- 完了条件 3: 劣化中は読み取りを叩いても tick が約定させない ---

  it("劣化中は読み取りを叩いても market の tick が約定させない", async () => {
    const state = buildState({
      balances: { jpy: 100_000_000 },
      createdAt: iso(NOW - 600_000),
      updatedAt: iso(NOW - 600_000),
      lastTickAt: iso(NOW - 300_000),
      orders: [
        buildOrder({
          id: "1",
          price: 5_000_000,
          startAmount: 0.001,
          orderedAt: iso(NOW - 300_000),
          updatedAt: iso(NOW - 300_000),
        }),
      ],
    });
    const { fastify, store, close } = await buildDegradable({
      state,
      fillMode: "market",
      // この足なら指値 5,000,000 の買いは約定する。
      candles: { btc_jpy: [candle(NOW - 120_000, 4_900_000, 4_900_000, 4_900_000, 4_900_000)] },
    });
    try {
      // 劣化前は約定することを先に確かめる（テストが空振りしていないことの確認）。
      await fastify.inject({ method: "GET", url: "/v1/user/spot/active_orders?pair=btc_jpy" });
      expect(store.state().trades).toHaveLength(1);
      expect(store.persistHealth().lastError).not.toBeNull(); // 約定したので書きに行って失敗した
      expect(store.isDegraded()).toBe(true);

      const filledAt = JSON.stringify(store.state());
      // 劣化後は、読み取りを何度叩いてもメモリが動かない。
      for (let i = 0; i < 3; i += 1) {
        const res = await fastify.inject({
          method: "GET",
          url: "/v1/user/spot/active_orders?pair=btc_jpy",
        });
        expect(res.statusCode).toBe(200);
      }
      expect(JSON.stringify(store.state())).toBe(filledAt);
    } finally {
      await close();
    }
  });

  // --- 完了条件 4: ignore で v0.1.0 の挙動に戻る ---

  it("ignore なら劣化せず、失敗しても今までどおり通る", async () => {
    const { fastify, store, close } = await buildDegradable({ mode: "ignore" });
    try {
      await degrade(store);
      expect(store.isDegraded()).toBe(false);

      const res = await fastify.inject({
        method: "POST",
        url: "/v1/user/spot/order",
        payload: { pair: "btc_jpy", side: "buy", type: "limit", price: 5_000_000, amount: 0.001 },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(1);
      expect(store.state().orders).toHaveLength(3);
      // 記録は ignore でも残る（PR 2）。
      expect(store.persistHealth().lastError).not.toBeNull();
    } finally {
      await close();
    }
  });

  // --- 失敗の引き金になった要求自体も断る ---

  it("書き込みに失敗した当の要求も断るが、巻き戻さないので状態には残る", async () => {
    const { fastify, store, close } = await buildDegradable();
    try {
      expect(store.isDegraded()).toBe(false); // まだ劣化していない
      const res = await fastify.inject({
        method: "POST",
        url: "/v1/user/spot/order",
        payload: { pair: "btc_jpy", side: "buy", type: "limit", price: 5_000_000, amount: 0.001 },
      });

      // preHandler では素通りし、persist が失敗したので preSerialization で差し替わる。
      expect(res.json()).toEqual({ success: 0, data: { code: 70001 } });
      // 巻き戻さない（合流した書き込みの巻き戻しは安全でない。10.5 の「採らなかった案」）。
      // 断られた注文はメモリに残り、読み取りから見つけられる。
      expect(store.state().orders).toHaveLength(3);
      const active = await fastify.inject({
        method: "GET",
        url: "/v1/user/spot/active_orders?pair=btc_jpy",
      });
      expect(active.json().data.orders).toHaveLength(2);
      // 再送は断られるので二重注文にはならない。
      const retry = await fastify.inject({
        method: "POST",
        url: "/v1/user/spot/order",
        payload: { pair: "btc_jpy", side: "buy", type: "limit", price: 5_000_000, amount: 0.001 },
      });
      expect(retry.json()).toEqual({ success: 0, data: { code: 70001 } });
      expect(store.state().orders).toHaveLength(3);
    } finally {
      await close();
    }
  });

  // --- 劣化していないときは何も変わらない ---

  it("劣化していなければ状態を変える要求は今までどおり通る", async () => {
    const path = join(dir, "ok", "state.json");
    const store = new SessionStore(seededState(), { path, fillMode: "manual", feeRate: 0 });
    const fastify = await buildServer({ store, logger: false, controlEnabled: true });
    try {
      const res = await fastify.inject({
        method: "POST",
        url: "/v1/user/spot/order",
        payload: { pair: "btc_jpy", side: "buy", type: "limit", price: 5_000_000, amount: 0.001 },
      });
      expect(res.json().success).toBe(1);
      expect(store.isDegraded()).toBe(false);
    } finally {
      await fastify.close();
    }
  });

  // --- 未登録のパスは劣化中も 404 のまま ---

  // 見ているのは「劣化が未登録パスの応答を変えないこと」。基準値そのものではない
  // （基準値は src/server/http.ts の registerNotFoundHandler が持ち、実 API の実測で決まる）。
  // 劣化前後を比べる形にしておくと、基準値が変わってもこの意図は壊れない。
  it.each([
    ["/v1/user/spot/nope", "互換ルートの配下"],
    ["/v1/nope", "/v1/ 直下"],
    ["/_control/nope", "/_control/ 配下"],
  ])("劣化は未登録パスの応答を変えない: %s（%s）", async (url) => {
    const { fastify, store, close } = await buildDegradable();
    try {
      const before = await fastify.inject({ method: "POST", url });
      await degrade(store);
      const after = await fastify.inject({ method: "POST", url });
      expect(after.statusCode).toBe(before.statusCode);
      expect(after.json()).toEqual(before.json());
    } finally {
      await close();
    }
  });
});

describe("経路の分類", () => {
  it("HEAD は GET と同じ鍵になる（Fastify が GET から自動登録する）", () => {
    expect(routeKey("HEAD", "/v1/user/assets")).toBe("GET /v1/user/assets");
  });

  // メソッドで機械的に判定すると注文状態の照合の主経路を劣化中に殺す。
  it("POST /v1/user/spot/orders_info は読み取りとして分類されている", () => {
    expect(READ_ROUTES.has("POST /v1/user/spot/orders_info")).toBe(true);
    expect(MUTATING_ROUTES.has("POST /v1/user/spot/orders_info")).toBe(false);
  });

  it("状態ファイルに書かない control の口は /_control/ だけで、他の 2 つと重ならず、劣化中も通す", () => {
    expect(NON_PERSISTING_CONTROL_ROUTES.size).toBeGreaterThan(0);
    for (const key of NON_PERSISTING_CONTROL_ROUTES) {
      expect(key).toMatch(/^[A-Z]+ \/_control\//);
      expect(READ_ROUTES.has(key)).toBe(false);
      expect(MUTATING_ROUTES.has(key)).toBe(false);
      const [method, url] = key.split(" ") as [string, string];
      expect(passesWhileDegraded(method, url)).toBe(true);
      expect(() => assertRouteClassified(method, url)).not.toThrow();
    }
    expect(passesWhileDegraded("GET", "/v1/user/assets")).toBe(true);
    expect(passesWhileDegraded("POST", "/_control/reset")).toBe(false);
  });

  it("分類済みの経路は通り、未分類は throw する", () => {
    expect(() => assertRouteClassified("GET", "/v1/user/assets")).not.toThrow();
    expect(() => assertRouteClassified("POST", "/v1/user/spot/order")).not.toThrow();
    expect(() => assertRouteClassified("HEAD", "/_control/state")).not.toThrow();
    expect(() => assertRouteClassified("POST", "/v1/user/spot/amend_order")).toThrow(
      /unclassified route POST \/v1\/user\/spot\/amend_order/,
    );
  });

  // 起動時に落とすので、分類し忘れた経路を持つサーバは建たない。
  it("未分類の経路を登録するとサーバが建たない", async () => {
    const store = new SessionStore(buildState(), { path: null, fillMode: "manual" });
    await expect(
      buildServer({
        store,
        logger: false,
        controlEnabled: false,
        // buildServer の中で登録される経路はすべて分類済みなので、ここでは
        // register を挟んで未分類の経路を足す形で確かめる。
      }).then(async (fastify) => {
        try {
          fastify.get("/v1/user/spot/unclassified", async () => ({}));
          await fastify.ready();
        } finally {
          await fastify.close();
        }
      }),
    ).rejects.toThrow(/unclassified route/);
  });

  it("既定のモードは degrade で、ignore だけが例外", () => {
    expect(persistFailureMode({})).toBe("degrade");
    expect(persistFailureMode({ BITBANK_MOCK_PERSIST_FAILURE: "" })).toBe("degrade");
    expect(persistFailureMode({ BITBANK_MOCK_PERSIST_FAILURE: "なにか" })).toBe("degrade");
    expect(persistFailureMode({ BITBANK_MOCK_PERSIST_FAILURE: "degrade" })).toBe("degrade");
    expect(persistFailureMode({ BITBANK_MOCK_PERSIST_FAILURE: "ignore" })).toBe("ignore");
  });
});
