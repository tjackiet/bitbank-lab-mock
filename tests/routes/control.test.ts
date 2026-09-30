import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadState } from "../../src/engine/persist.ts";
import { activeOrders } from "../../src/engine/state.ts";
import { controlRoutes, controlTokenHeader } from "../../src/routes/control.ts";
import { buildServer } from "../../src/server/http.ts";
import { SessionStore } from "../../src/store/session.ts";
import type { PrivateStreamMessage } from "../../src/stream/events.ts";
import { DEFAULT_HOLD_LIMIT } from "../../src/stream/hub.ts";
import { buildOrder, buildState, buildTrade } from "../engine/helpers.ts";

/** src/routes/control.ts の `MAX_CLOCK_AHEAD_MS` と同じ値（実装は export していない）。 */
const MAX_CLOCK_AHEAD_MS = 24 * 60 * 60 * 1000;

async function buildControl(
  state = buildState({
    balances: { jpy: 10_000_000 },
    orders: [buildOrder({ id: "1", price: 5_000_000, startAmount: 0.001 })],
  }),
  opts: { token?: string; controlEnabled?: boolean; streamHoldLimit?: number } = {},
) {
  const store = new SessionStore(state, { path: null, fillMode: "manual" });
  const fastify = await buildServer({
    store,
    logger: false,
    controlEnabled: opts.controlEnabled ?? true,
    controlToken: opts.token,
    streamHoldLimit: opts.streamHoldLimit,
  });
  return { fastify, store };
}

describe("GET/POST /_control without BITBANK_MOCK_CONTROL", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  it("returns 404 when control is disabled", async () => {
    const { fastify } = await buildControl(buildState(), { controlEnabled: false });
    cleanups.push(async () => {
      await fastify.close();
    });
    const res = await fastify.inject({ method: "GET", url: "/_control/state" });
    expect(res.statusCode).toBe(404);
  });
});

describe("/_control routes", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  async function setup(
    state?: Parameters<typeof buildControl>[0],
    opts?: Parameters<typeof buildControl>[1],
  ) {
    const r = await buildControl(state, opts);
    cleanups.push(async () => {
      await r.fastify.close();
    });
    return r;
  }

  it("returns state on loopback", async () => {
    const { fastify, store } = await setup();
    const res = await fastify.inject({ method: "GET", url: "/_control/state" });
    expect(res.statusCode).toBe(200);
    // PaperState に、状態ファイルへの書き出しの状況と足の取得の状況を添えて返す。
    expect(res.json()).toEqual({
      ...store.state(),
      persist: store.persistHealth(),
      candles: store.candlesHealth(),
    });
    expect(res.json().persist).toEqual({ lastError: null, consecutiveFailures: 0 });
    // 一度も取りに行っていない状態。`fillMode` があるので、manual だから取りに行って
    // いないのか、market でまだ機会が無いだけなのかを応答だけで読み分けられる。
    expect(res.json().candles).toEqual({
      lastError: null,
      consecutiveFailures: 0,
      lastSuccessAt: null,
      fillMode: "manual",
    });
  });

  // `persist` と `candles` は PaperState の一部ではない。PaperStateSchema は不明なキーを
  // 落とすので、この応答をそのまま状態ファイルへ書き戻しても読み込みは通る。
  it("応答をそのまま状態ファイルへ書き戻しても読み込める", async () => {
    const { fastify, store } = await setup();
    const res = await fastify.inject({ method: "GET", url: "/_control/state" });
    expect(res.json().persist).toBeDefined();
    expect(res.json().candles).toBeDefined();

    const dir = await mkdtemp(join(tmpdir(), "bitbank-mock-control-"));
    try {
      const path = join(dir, "state.json");
      await writeFile(path, JSON.stringify(res.json(), null, 2));
      expect(await loadState(path)).toEqual({ success: true, data: store.state() });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("forbids non-loopback when no token is configured", async () => {
    const { fastify } = await setup();
    const res = await fastify.inject({
      method: "GET",
      url: "/_control/state",
      remoteAddress: "10.0.0.8",
    });
    expect(res.statusCode).toBe(403);
  });

  it("forbids non-loopback without a token", async () => {
    const { fastify } = await setup(undefined, { token: "secret" });
    const res = await fastify.inject({
      method: "GET",
      url: "/_control/state",
      remoteAddress: "10.0.0.8",
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "FORBIDDEN" });
  });

  it("allows non-loopback with the matching token", async () => {
    const { fastify } = await setup(undefined, { token: "secret" });
    const res = await fastify.inject({
      method: "GET",
      url: "/_control/state",
      remoteAddress: "10.0.0.8",
      headers: { "x-control-token": "secret" },
    });
    expect(res.statusCode).toBe(200);
  });

  // 誤ったトークンは、違う位置・違う長さのどちらでも同じ 403 になる。
  it.each([["secreT"], ["Secret"], ["s"], ["secret "], ["secretsecret"]])(
    "forbids non-loopback with a wrong token: %s",
    async (token) => {
      const { fastify } = await setup(undefined, { token: "secret" });
      const res = await fastify.inject({
        method: "GET",
        url: "/_control/state",
        remoteAddress: "10.0.0.8",
        headers: { "x-control-token": token },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "FORBIDDEN" });
    },
  );

  // 同名ヘッダが 2 行来ると Node は request.headers 側で ", " 繋ぎの 1 本にするので、
  // 繋いだ結果が設定値と一致し得る。行数は生ヘッダで数えて 1 本のときだけ受ける。
  it("takes the token only when exactly one header line carries it", () => {
    /** 生ヘッダだけを持つ最小の request を作る（`controlTokenHeader` はそこしか見ない）。 */
    const withRaw = (rawHeaders: string[]) =>
      ({ raw: { rawHeaders } }) as unknown as Parameters<typeof controlTokenHeader>[0];
    expect(controlTokenHeader(withRaw(["Host", "x", "X-Control-Token", "secret"]))).toBe("secret");
    expect(controlTokenHeader(withRaw(["host", "x", "x-control-token", "secret"]))).toBe("secret");
    expect(controlTokenHeader(withRaw(["Host", "x"]))).toBeNull();
    expect(
      controlTokenHeader(withRaw(["X-Control-Token", "part1", "X-Control-Token", "part2"])),
    ).toBeNull();
  });

  // 許可判定はソケットの対向アドレスだけを見る。trustProxy を有効にしたサーバでも
  // X-Forwarded-For でループバックを騙れない（buildServer は trustProxy を設定しないが、
  // 判定が request.ip に依存していると、有効にした瞬間に境界が消える）。
  it("ignores X-Forwarded-For even when the server trusts proxies", async () => {
    const store = new SessionStore(buildState(), { path: null, fillMode: "manual" });
    const fastify = Fastify({ logger: false, trustProxy: true });
    fastify.decorate("store", store);
    await fastify.register(controlRoutes, { prefix: "/_control", token: "secret" });
    cleanups.push(async () => {
      await fastify.close();
    });
    for (const forwarded of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.0.0.1, 10.0.0.8"]) {
      const res = await fastify.inject({
        method: "GET",
        url: "/_control/state",
        remoteAddress: "10.0.0.8",
        headers: { "x-forwarded-for": forwarded },
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it("fills an active order completely", async () => {
    const { fastify, store } = await setup();
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/orders/1/fill",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      order: { status: string; executed_amount: string };
      trade: { amount: string };
    };
    expect(body.order.status).toBe("FULLY_FILLED");
    expect(body.order.executed_amount).toBe("0.0010");
    expect(body.trade.amount).toBe("0.0010");
    expect(activeOrders(store.state())).toHaveLength(0);
  });

  it("partially fills when amount is less than remaining", async () => {
    const { fastify } = await setup();
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/orders/1/fill",
      payload: { amount: 0.0004 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      order: {
        status: string;
        executed_amount: string;
        remaining_amount: string;
        average_price: string;
      };
    };
    expect(body.order.status).toBe("PARTIALLY_FILLED");
    expect(body.order.executed_amount).toBe("0.0004");
    expect(body.order.remaining_amount).toBe("0.0006");
    expect(body.order.average_price).toBe("5000000");
  });

  it("returns 404 when the order does not exist", async () => {
    const { fastify } = await setup();
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/orders/999/fill",
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "ORDER_NOT_FOUND" });
  });

  it("returns 409 when the order is terminal", async () => {
    const { fastify } = await setup(
      buildState({
        orders: [
          buildOrder({
            id: "1",
            status: "CANCELED_UNFILLED",
            canceledAt: "2026-01-01T00:01:00.000Z",
          }),
        ],
      }),
    );
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/orders/1/fill",
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "ORDER_NOT_ACTIVE", status: "CANCELED_UNFILLED" });
  });

  it("returns 400 when amount exceeds remaining", async () => {
    const { fastify, store } = await setup();
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/orders/1/fill",
      payload: { amount: 0.002 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "INVALID_AMOUNT", remaining: 0.001 });
    expect(activeOrders(store.state())).toHaveLength(1);
  });

  it("returns 400 when amount has extra digits", async () => {
    const { fastify, store } = await setup();
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/orders/1/fill",
      payload: { amount: 0.00001 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "INVALID_AMOUNT", remaining: 0.001 });
    expect(store.state().trades).toHaveLength(0);
  });

  it("returns 400 when a supplied fill price has extra digits", async () => {
    const { fastify, store } = await setup(
      buildState({
        balances: { jpy: 0, btc: 0.001 },
        orders: [buildOrder({ id: "1", side: "sell", price: 5_000_000, startAmount: 0.001 })],
      }),
    );
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/orders/1/fill",
      payload: { price: 5_000_000.5 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "INVALID_PRICE" });
    expect(store.state().trades).toHaveLength(0);
  });

  /**
   * `fill` の `price` / `amount` の **0 と負**。
   *
   * 既存は `amount` が残量超過（`0.002`）と桁溢れ（`0.00001`）、`price` が桁溢れと
   * `Infinity` だけで、**0 と負をどちらも通っていなかった**。そのため
   * `price <= 0` を `< 0` に、`amount <= 0` を `< 0` に変えても 1 件も落ちない（実測）。
   *
   * 0 を通すと、約定価格 0 の trade や数量 0 の trade が state に残る。
   * `docs/fidelity.md` の「control の fill / tick 検証」節が
   * 「`amount` が非正…は 400 `INVALID_AMOUNT`」「`price` が非正・非有限は 400
   * `INVALID_PRICE`」と明記している挙動である。
   */
  it.each([
    ["price が 0", { price: 0 }, "INVALID_PRICE"],
    ["price が負", { price: -1 }, "INVALID_PRICE"],
    ["amount が 0", { amount: 0 }, "INVALID_AMOUNT"],
    ["amount が負", { amount: -0.001 }, "INVALID_AMOUNT"],
  ])("fill は %s を断り、状態を変えない", async (_label, payload, error) => {
    const { fastify, store } = await setup();
    const before = JSON.stringify(store.state());

    const res = await fastify.inject({
      method: "POST",
      url: "/_control/orders/1/fill",
      payload,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error });
    expect(JSON.stringify(store.state())).toBe(before);
  });

  it("returns 400 when price is not a finite positive number", async () => {
    const { fastify } = await setup();
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/orders/1/fill",
      payload: { price: Number.POSITIVE_INFINITY },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "INVALID_PRICE" });
  });

  it("ticks matching orders from a synthetic price", async () => {
    const { fastify, store } = await setup();
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/tick",
      payload: { pair: "btc_jpy", price: 4_900_000 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { filled: unknown[] };
    expect(body.filled).toHaveLength(1);
    expect(activeOrders(store.state())).toHaveLength(0);
  });

  // 互換ルートと同じ pairAssets で弾く。状態ファイル由来の文字種が不正なペアを
  // runTick へ渡すと applyFill が失敗して tick ごと断られるので、ここで 400 にする。
  it.each([["../../admin_jpy"], ["btc?a=1_jpy"], ["btc#frag_jpy"], ["btc_jpy_x"], [""]])(
    "rejects a malformed pair without filling: %s",
    async (pair) => {
      const { fastify, store } = await setup();
      const res = await fastify.inject({
        method: "POST",
        url: "/_control/tick",
        payload: { pair, price: 4_900_000 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "INVALID_PAIR" });
      expect(activeOrders(store.state())).toHaveLength(1);
    },
  );

  // 状態ファイルから読んだ不正なペアの注文へ tick しても 500 にはならない。
  it("returns 400 instead of 500 for an order carrying a malformed pair", async () => {
    const { fastify, store } = await setup(
      buildState({
        balances: { jpy: 10_000_000, btc: 1 },
        orders: [buildOrder({ id: "1", pair: "../../admin_jpy", side: "sell", price: 5_000_000 })],
      }),
    );
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/tick",
      payload: { pair: "../../admin_jpy", price: 6_000_000 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "INVALID_PAIR" });
    expect(activeOrders(store.state())).toHaveLength(1);
  });

  it("rejects an invalid candle without filling", async () => {
    const { fastify, store } = await setup();
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/tick",
      payload: {
        pair: "btc_jpy",
        candle: { open: 1, high: Number.POSITIVE_INFINITY, low: 1, close: 1 },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "INVALID_CANDLE" });
    expect(activeOrders(store.state())).toHaveLength(1);
  });

  it("rejects a candle with non-finite volume", async () => {
    const { fastify, store } = await setup();
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/tick",
      payload: { pair: "btc_jpy", candle: { open: 1, high: 1, low: 1, close: 1, vol: "invalid" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "INVALID_CANDLE" });
    expect(activeOrders(store.state())).toHaveLength(1);
  });

  // Date の表現範囲を超える timestamp は有限でも足として使えない。runTick の
  // new Date(nowMs).toISOString() が RangeError になり 500 を返していた経路。
  it.each([[1e20], [8.64e15], [-1e20]])(
    "rejects a candle timestamp outside the Date range without filling: %s",
    async (timestamp) => {
      const { fastify, store } = await setup();
      const before = JSON.stringify(store.state());
      const res = await fastify.inject({
        method: "POST",
        url: "/_control/tick",
        payload: { pair: "btc_jpy", candle: { open: 1, high: 1, low: 1, close: 1, timestamp } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "INVALID_CANDLE" });
      expect(JSON.stringify(store.state())).toBe(before);
    },
  );

  // ---- control の時計（lastTickAt）が実時間から無制限に離れないこと ----
  //
  // 進む経路は 2 つ（足の timestamp と tick ごとの 60 秒の単調前進）で、上限
  // （MAX_CLOCK_AHEAD_MS = 24 時間）は両方に効く。片方だけではもう片方から進む。

  // (b) 単調前進。1 tick 60 秒なので 1440 回で上限に届く。それを越える回数を回しても
  // 時計は上限の内側に留まり、越える tick は 400 で断られる（状態は変えない）。
  it("keeps lastTickAt within the cap however many times tick repeats", async () => {
    const { fastify, store } = await setup(buildState());
    const ticks = 1600;
    let refused = 0;
    let lastRefusal: unknown = null;
    for (let i = 0; i < ticks; i++) {
      const res = await fastify.inject({
        method: "POST",
        url: "/_control/tick",
        payload: { pair: "btc_jpy", price: 1000 },
      });
      if (res.statusCode !== 200) {
        refused += 1;
        lastRefusal = res.json();
        expect(res.statusCode).toBe(400);
      }
    }
    // 1440 回分は今までどおり通り、残りが断られる。
    expect(refused).toBeGreaterThan(0);
    expect(refused).toBeLessThan(ticks);
    expect(lastRefusal).toMatchObject({ error: "CLOCK_TOO_FAR_AHEAD" });
    const ahead = Date.parse(store.state().lastTickAt) - Date.now();
    expect(ahead).toBeLessThanOrEqual(MAX_CLOCK_AHEAD_MS);
  });

  // 断られた tick は状態を変えない（時計も注文も動かない）。
  it("leaves state untouched when a tick is refused at the cap", async () => {
    const { fastify, store } = await setup(
      buildState({ lastTickAt: new Date(Date.now() + MAX_CLOCK_AHEAD_MS).toISOString() }),
    );
    const before = JSON.stringify(store.state());
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/tick",
      payload: { pair: "btc_jpy", price: 1000 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "CLOCK_TOO_FAR_AHEAD" });
    expect(JSON.stringify(store.state())).toBe(before);
  });

  // (a) 足の timestamp。Date の表現範囲には収まるが実時間から遠すぎる値は、
  // 上の Date 範囲の検査（INVALID_CANDLE）とは別の CANDLE_TOO_FAR_AHEAD で断る。
  it.each([[4e12], [1e15]])(
    "rejects a candle timestamp too far ahead of real time without touching state: %s",
    async (timestamp) => {
      const { fastify, store } = await setup();
      const before = JSON.stringify(store.state());
      const res = await fastify.inject({
        method: "POST",
        url: "/_control/tick",
        payload: { pair: "btc_jpy", candle: { open: 1, high: 1, low: 1, close: 1, timestamp } },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "CANDLE_TOO_FAR_AHEAD" });
      expect(JSON.stringify(store.state())).toBe(before);
    },
  );

  // 上限の内側なら先の足も今までどおり通る（境界の直下）。
  it("still accepts a candle just inside the cap", async () => {
    const { fastify, store } = await setup(buildState());
    const timestamp = Date.now() + MAX_CLOCK_AHEAD_MS - 60_000;
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/tick",
      payload: { pair: "btc_jpy", candle: { open: 1, high: 1, low: 1, close: 1, timestamp } },
    });
    expect(res.statusCode).toBe(200);
    expect(Date.parse(store.state().lastTickAt)).toBe(timestamp);
  });

  /**
   * 上限（実時刻 + 24 時間）の**ちょうど**を踏む。
   *
   * 上の 3 件はいずれも境界から 60 秒離れている（`lastTickAt` を上限に置いて 60 秒の
   * 前進で越える形、`+ MAX_CLOCK_AHEAD_MS - 60_000`、`+ MAX_CLOCK_AHEAD_MS + 60_000`）。
   * そのため `nowMs > maxMs` / `candle.timestamp > maxMs` / `ms > maxMs` の 3 箇所を
   * すべて `>=` に変えても 1 件も落ちない（実測）。README と対応表が「24 時間まで」と
   * 明記している挙動なので、その "まで" が inclusive か exclusive かは契約である。
   *
   * `maxMs` はハンドラ内の `Date.now()` から作るので、実時刻のままでは 1 ミリ秒を
   * 狙えない。**`Date` だけを固定して踏む**——`toFake` を絞らずに `useFakeTimers()` と
   * すると下の 3 件が揃って失敗し、このファイルの実行が 1.5 秒から 16.5 秒へ伸びる
   * （タイマまで偽物になって fastify 内部の待ちが進まず、テストのタイムアウトに
   * 当たる。実測）。
   */
  describe("上限ちょうどの境界", () => {
    const FIXED = Date.parse("2026-06-01T00:00:00.000Z");
    const maxMs = FIXED + MAX_CLOCK_AHEAD_MS;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(FIXED);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("tick: 60 秒の前進が上限ちょうどに着くなら通し、1 ミリ秒超えたら断る", async () => {
      // `nowMs = max(realNow, lastMs + 60_000)` なので、`lastTickAt` を「上限 − 60 秒」に
      // 置くと前進後がちょうど上限になる。
      const tickFrom = async (lastTickAtMs: number) => {
        const { fastify, store } = await setup(
          buildState({ lastTickAt: new Date(lastTickAtMs).toISOString() }),
        );
        const before = JSON.stringify(store.state());
        const res = await fastify.inject({
          method: "POST",
          url: "/_control/tick",
          payload: { pair: "btc_jpy", price: 1000 },
        });
        return { res, store, before };
      };

      const exact = await tickFrom(maxMs - 60_000);
      expect(exact.res.statusCode).toBe(200);
      expect(Date.parse(exact.store.state().lastTickAt)).toBe(maxMs);

      const over = await tickFrom(maxMs - 60_000 + 1);
      expect(over.res.statusCode).toBe(400);
      expect(over.res.json()).toMatchObject({ error: "CLOCK_TOO_FAR_AHEAD" });
      expect(JSON.stringify(over.store.state())).toBe(over.before);
    });

    it("tick: 足の timestamp が上限ちょうどなら通し、1 ミリ秒超えたら断る", async () => {
      const tickWithTimestamp = async (timestamp: number) => {
        const { fastify, store } = await setup(buildState());
        const before = JSON.stringify(store.state());
        const res = await fastify.inject({
          method: "POST",
          url: "/_control/tick",
          payload: { pair: "btc_jpy", candle: { open: 1, high: 1, low: 1, close: 1, timestamp } },
        });
        return { res, store, before };
      };

      const exact = await tickWithTimestamp(maxMs);
      expect(exact.res.statusCode).toBe(200);
      expect(Date.parse(exact.store.state().lastTickAt)).toBe(maxMs);

      const over = await tickWithTimestamp(maxMs + 1);
      expect(over.res.statusCode).toBe(400);
      expect(over.res.json()).toMatchObject({ error: "CANDLE_TOO_FAR_AHEAD" });
      expect(JSON.stringify(over.store.state())).toBe(over.before);
    });

    it("clock: 上限ちょうどへは動かせて、1 ミリ秒超えたら断る", async () => {
      const setClock = async (lastTickAt: number) => {
        const { fastify, store } = await setup(buildState());
        const before = JSON.stringify(store.state());
        const res = await fastify.inject({
          method: "POST",
          url: "/_control/clock",
          payload: { lastTickAt },
        });
        return { res, store, before };
      };

      const exact = await setClock(maxMs);
      expect(exact.res.statusCode).toBe(200);
      expect(Date.parse(exact.store.state().lastTickAt)).toBe(maxMs);

      const over = await setClock(maxMs + 1);
      expect(over.res.statusCode).toBe(400);
      expect(over.res.json()).toMatchObject({ error: "CLOCK_TOO_FAR_AHEAD" });
      expect(JSON.stringify(over.store.state())).toBe(over.before);
    });
  });

  // 過去の足を流し直す用途は塞がない。上限は先の側だけに効く。
  it("still accepts a past timestamp and fills from it", async () => {
    const { fastify, store } = await setup();
    const timestamp = Date.now() - 60 * 60 * 1000;
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/tick",
      payload: {
        pair: "btc_jpy",
        candle: { open: 4_900_000, high: 4_900_000, low: 4_900_000, close: 4_900_000, timestamp },
      },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { filled: unknown[] }).filled).toHaveLength(1);
    expect(activeOrders(store.state())).toHaveLength(0);
  });

  // (b) の意図: 足は 1 分足なので、同じ実時刻に 2 本注入されても別の窓に落ちなければ
  // ならない。上限を入れても、上限に当たらない限りこの 60 秒の前進は変わらない。
  it("keeps two candles injected at the same wall clock in separate windows", async () => {
    const { fastify, store } = await setup(
      buildState({
        balances: { jpy: 10_000_000 },
        orders: [
          buildOrder({ id: "1", price: 5_000_000, startAmount: 0.001 }),
          buildOrder({ id: "2", price: 4_000_000, startAmount: 0.001 }),
        ],
      }),
    );
    const tick = (price: number) =>
      fastify.inject({
        method: "POST",
        url: "/_control/tick",
        payload: { pair: "btc_jpy", price },
      });
    // 1 本目は注文 1 だけ、2 本目は注文 2 だけに当たる価格を選ぶ。
    const first = (await tick(4_500_000)).json() as { filled: unknown[]; lastTickAt: string };
    const second = (await tick(3_500_000)).json() as { filled: unknown[]; lastTickAt: string };
    expect(first.filled).toHaveLength(1);
    expect(second.filled).toHaveLength(1);
    // 2 本目の窓は 1 本目より必ず 60 秒以上先にある（同じ窓には落ちない）。
    expect(Date.parse(second.lastTickAt) - Date.parse(first.lastTickAt)).toBeGreaterThanOrEqual(
      60_000,
    );
    const [t1, t2] = store.state().trades;
    expect(Date.parse(t2!.executedAt) - Date.parse(t1!.executedAt)).toBeGreaterThanOrEqual(60_000);
  });

  // ---- POST /_control/clock: 時計だけを戻す口 ----

  // 上限に当たった後の復旧。reset と違って注文・約定・残高は残る。
  it("rewinds the clock without dropping orders, trades or balances", async () => {
    // 約定済みの注文 2 とその trade を仕込む（buildState の trades は既定で空なので、
    // 仕込まないと「約定記録が残る」ことを検査できない）。
    const trade = buildTrade({ tradeId: "1", orderId: "2" });
    const { fastify, store } = await setup(
      buildState({
        lastTickAt: new Date(Date.now() + MAX_CLOCK_AHEAD_MS).toISOString(),
        balances: { jpy: 9_000_000, btc: 0.5 },
        orders: [
          buildOrder({ id: "1", price: 5_000_000, startAmount: 0.001 }),
          buildOrder({
            id: "2",
            price: 5_000_000,
            startAmount: 0.001,
            status: "FULLY_FILLED",
            executedAmount: 0.001,
            executedNotional: 5_000,
          }),
        ],
        trades: [trade],
        nextOrderSeq: 3,
        nextTradeSeq: 2,
      }),
    );
    const res = await fastify.inject({ method: "POST", url: "/_control/clock" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { lastTickAt: string; previousLastTickAt: string };
    expect(Math.abs(Date.parse(body.lastTickAt) - Date.now())).toBeLessThan(60_000);
    expect(body.previousLastTickAt).not.toBe(body.lastTickAt);
    expect(store.state().balances).toEqual({ jpy: 9_000_000, btc: 0.5 });
    expect(store.state().trades).toEqual([trade]);
    expect(activeOrders(store.state())).toHaveLength(1);
    // 戻した後は tick が通る。
    const after = await fastify.inject({
      method: "POST",
      url: "/_control/tick",
      payload: { pair: "btc_jpy", price: 1000 },
    });
    expect(after.statusCode).toBe(200);
  });

  it.each([
    ["2026-01-01T00:00:00.000Z" as unknown, Date.parse("2026-01-01T00:00:00.000Z")],
    [Date.parse("2026-01-01T00:00:00.000Z") as unknown, Date.parse("2026-01-01T00:00:00.000Z")],
  ])("accepts an ISO string or epoch ms for lastTickAt: %s", async (lastTickAt, expected) => {
    const { fastify, store } = await setup(buildState());
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/clock",
      payload: { lastTickAt },
    });
    expect(res.statusCode).toBe(200);
    expect(Date.parse(store.state().lastTickAt)).toBe(expected);
  });

  // 時計を戻す口も、時計を上限より先へは動かせない。
  it("refuses to set the clock past the cap and leaves state untouched", async () => {
    const { fastify, store } = await setup(buildState());
    const before = JSON.stringify(store.state());
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/clock",
      payload: { lastTickAt: Date.now() + MAX_CLOCK_AHEAD_MS + 60_000 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "CLOCK_TOO_FAR_AHEAD" });
    expect(JSON.stringify(store.state())).toBe(before);
  });

  it.each([["not a date"], [Number.NaN], [1e20], [{ ms: 1 }], [null]])(
    "rejects a malformed lastTickAt without touching state: %s",
    async (lastTickAt) => {
      const { fastify, store } = await setup(buildState());
      const before = JSON.stringify(store.state());
      const res = await fastify.inject({
        method: "POST",
        url: "/_control/clock",
        payload: { lastTickAt },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "INVALID_CLOCK" });
      expect(JSON.stringify(store.state())).toBe(before);
    },
  );

  // 本文そのものが壊れている場合（配列・null・数値・文字列）は「本文なし」と区別して
  // 断る。`asRecord() ?? {}` だと現在時刻への巻き戻しが黙って走ってしまう。
  it.each([["[]"], ["null"], ['"s"'], ["123"]])(
    "rejects a malformed request body without touching state: %s",
    async (payload) => {
      const { fastify, store } = await setup(
        buildState({ lastTickAt: "2026-01-01T00:00:00.000Z" }),
      );
      const before = JSON.stringify(store.state());
      const res = await fastify.inject({
        method: "POST",
        url: "/_control/clock",
        headers: { "content-type": "application/json" },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "INVALID_CLOCK" });
      expect(JSON.stringify(store.state())).toBe(before);
    },
  );

  // 時計を戻す口は /_control/ の中に閉じる。非ループバックからの境界は他の口と同じで、
  // control 無効時はルート自体が登録されない（= 互換ルートの仕様に混ざらない）。
  it("keeps the clock route inside the /_control boundary", async () => {
    const { fastify } = await setup(undefined, { token: "secret" });
    const forbidden = await fastify.inject({
      method: "POST",
      url: "/_control/clock",
      remoteAddress: "10.0.0.8",
    });
    expect(forbidden.statusCode).toBe(403);
    const { fastify: disabled } = await setup(buildState(), { controlEnabled: false });
    const notFound = await disabled.inject({ method: "POST", url: "/_control/clock" });
    expect(notFound.statusCode).toBe(404);
  });

  // 資産キーは互換ルートが作るペアのセグメントと同じ文字種だけ通す。通してしまうと
  // GET /v1/user/assets の asset にそのまま現れ、状態ファイルにも残る。
  it.each([
    ['{"balances":{"":1}}'],
    ['{"balances":{"BTC":1}}'],
    ['{"balances":{"btc jpy":1}}'],
    ['{"balances":{"btc\\n2026-01-01 INFO injected":1}}'],
    ['{"balances":{"../../etc/passwd":1}}'],
  ])("rejects a malformed asset key without touching state: %s", async (payload) => {
    const { fastify, store } = await setup();
    const before = JSON.stringify(store.state());
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/reset",
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "INVALID_BALANCES" });
    expect(JSON.stringify(store.state())).toBe(before);
  });

  // __proto__ はルートへ届く前に Fastify の JSON パーサが本文ごと弾く。
  it("rejects a body carrying a __proto__ key before the route sees it", async () => {
    const { fastify, store } = await setup();
    const before = JSON.stringify(store.state());
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/reset",
      headers: { "content-type": "application/json" },
      payload: '{"balances":{"__proto__":1}}',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(store.state())).toBe(before);
    expect(Object.getPrototypeOf(store.state().balances)).toBe(Object.prototype);
  });

  /**
   * `reset` の **0 は妥当な値**なので通す。ここだけ他の 0 境界と向きが逆である。
   *
   * 既存の「resets state」は `initialJpy: 50_000` / `balances: { jpy: 50_000, btc: 1 }`
   * しか渡していないので、`initialJpy < 0` を `<= 0` に、`balances` の値の
   * `amount < 0` を `<= 0` に変えても 1 件も落ちない（実測）。**残高 0 の口座から
   * 始めるシナリオが黙って断られるようになる**——発注が残高不足で弾かれることを
   * 確かめる筋では普通に使う値である。
   */
  it("reset は initialJpy 0 と残高 0 を受け付ける", async () => {
    const { fastify, store } = await setup();
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/reset",
      payload: { initialJpy: 0, balances: { jpy: 0, btc: 0 } },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { initialJpy: number; balances: Record<string, number> };
    expect(body.initialJpy).toBe(0);
    expect(body.balances).toEqual({ jpy: 0, btc: 0 });
    // 応答だけでなく、書き込まれた状態も 0 になっていること。
    expect(store.state().initialJpy).toBe(0);
    expect(store.state().balances).toEqual({ jpy: 0, btc: 0 });
  });

  it.each([
    ["initialJpy が負", { initialJpy: -1 }],
    ["balances の値が負", { balances: { jpy: -1 } }],
  ])("reset は %s を断り、状態を変えない", async (_label, payload) => {
    const { fastify, store } = await setup();
    const before = JSON.stringify(store.state());

    const res = await fastify.inject({ method: "POST", url: "/_control/reset", payload });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "INVALID_BALANCES" });
    expect(JSON.stringify(store.state())).toBe(before);
  });

  it("resets state", async () => {
    const { fastify } = await setup();
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/reset",
      payload: { initialJpy: 50_000, balances: { jpy: 50_000, btc: 1 } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      orders: unknown[];
      balances: { jpy: number; btc: number };
      initialJpy: number;
    };
    expect(body.orders).toEqual([]);
    expect(body.balances).toEqual({ jpy: 50_000, btc: 1 });
    expect(body.initialJpy).toBe(50_000);
  });
});

/**
 * private stream の保留・再送の口。WebSocket を通した見え方は
 * `tests/routes/private-stream.test.ts`、溜め方そのものは `tests/stream/hub.test.ts` が見る。
 * ここでは HTTP の形（本文・ステータス・検証）を、hub に直接足した購読者で確かめる。
 */
describe("/_control/stream", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  const LIMIT_BUY = {
    pair: "btc_jpy",
    side: "buy",
    type: "limit",
    price: 5_000_000,
    amount: 0.001,
  } as const;

  async function setup(opts: Parameters<typeof buildControl>[1] = {}) {
    const r = await buildControl(buildState({ balances: { jpy: 10_000_000 } }), opts);
    cleanups.push(async () => {
      await r.fastify.close();
    });
    const sent: PrivateStreamMessage[] = [];
    r.fastify.privateStream.addClient({
      send: (text) => sent.push(JSON.parse(text)),
      close: () => {},
    });
    const order = () =>
      r.fastify.inject({ method: "POST", url: "/v1/user/spot/order", payload: LIMIT_BUY });
    const held = async () =>
      (await r.fastify.inject({ method: "GET", url: "/_control/stream/held" })).json();
    return { ...r, sent, order, held };
  }

  it("hold の後の変化は届かず、held に番号付きで溜まり、release で届く", async () => {
    const { fastify, sent, order, held } = await setup();
    const hold = await fastify.inject({ method: "POST", url: "/_control/stream/hold" });
    expect(hold.statusCode).toBe(200);
    expect(hold.json()).toEqual({
      holding: true,
      held: 0,
      limit: DEFAULT_HOLD_LIMIT,
      overflowed: false,
      dropped: 0,
    });

    await order();
    expect(sent).toEqual([]);
    const body = await held();
    expect(body).toMatchObject({ holding: true, held: 2, overflowed: false, dropped: 0 });
    expect(body.messages.map((m: { seq: number }) => m.seq)).toEqual([1, 2]);
    expect(
      body.messages.map((m: { frame: PrivateStreamMessage }) => m.frame.message.method),
    ).toEqual(["spot_order_new", "asset_update"]);

    const release = await fastify.inject({
      method: "POST",
      url: "/_control/stream/release",
      payload: { order: [2, 1, 2] },
    });
    expect(release.statusCode).toBe(200);
    expect(release.json()).toEqual({ sent: 3, omitted: [], clients: 1 });
    expect(sent.map((m) => m.message.method)).toEqual([
      "asset_update",
      "spot_order_new",
      "asset_update",
    ]);
    expect(await held()).toEqual({
      holding: false,
      held: 0,
      limit: DEFAULT_HOLD_LIMIT,
      overflowed: false,
      dropped: 0,
      messages: [],
    });
  });

  it("本文を省略した release と {} の release は溜めた順にすべて送る", async () => {
    const { fastify, sent, order } = await setup();
    for (const payload of [undefined, {}]) {
      sent.splice(0);
      await fastify.inject({ method: "POST", url: "/_control/stream/hold" });
      await order();
      const res = await fastify.inject({
        method: "POST",
        url: "/_control/stream/release",
        payload,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ sent: 2, omitted: [], clients: 1 });
      expect(sent.map((m) => m.message.method)).toEqual(["spot_order_new", "asset_update"]);
    }
  });

  it("送るものがあるのに接続が 0 本の release は 409 NO_STREAM_CLIENTS で断り、保留も溜めたものも残す", async () => {
    // 購読者を足さない（setup() は 1 人足すので使わない）。
    const r = await buildControl(buildState({ balances: { jpy: 10_000_000 } }));
    cleanups.push(async () => {
      await r.fastify.close();
    });
    await r.fastify.inject({ method: "POST", url: "/_control/stream/hold" });
    await r.fastify.inject({ method: "POST", url: "/v1/user/spot/order", payload: LIMIT_BUY });
    const held = () => r.fastify.inject({ method: "GET", url: "/_control/stream/held" });
    const before = (await held()).json();

    const res = await r.fastify.inject({ method: "POST", url: "/_control/stream/release" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "NO_STREAM_CLIENTS", held: 2 });
    expect((await held()).json()).toEqual(before);

    // 捨てたいときは空の order。送るものが 0 通なので接続が無くても通る。
    const discard = await r.fastify.inject({
      method: "POST",
      url: "/_control/stream/release",
      payload: { order: [] },
    });
    expect(discard.statusCode).toBe(200);
    expect(discard.json()).toEqual({ sent: 0, omitted: [1, 2], clients: 0 });
    expect((await held()).json()).toMatchObject({ holding: false, held: 0 });
  });

  it("保留していないときの release は 409 NOT_HOLDING", async () => {
    const { fastify } = await setup();
    const res = await fastify.inject({ method: "POST", url: "/_control/stream/release" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "NOT_HOLDING" });
  });

  it.each([
    { name: "配列の本文", payload: [1] },
    { name: "order が文字列", payload: { order: "1" } },
    { name: "order に文字列の番号", payload: { order: ["1"] } },
    { name: "order が null", payload: { order: null } },
    { name: "0 番", payload: { order: [0] } },
    { name: "溜めた数を超える番号", payload: { order: [3] } },
    { name: "整数でない番号", payload: { order: [1.5] } },
  ])("$name の release は 400 で断り、保留も溜めたものも残す", async ({ payload }) => {
    const { fastify, sent, order, held } = await setup();
    await fastify.inject({ method: "POST", url: "/_control/stream/hold" });
    await order();
    const before = await held();

    const res = await fastify.inject({ method: "POST", url: "/_control/stream/release", payload });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "INVALID_RELEASE_ORDER",
      held: 2,
      limit: DEFAULT_HOLD_LIMIT,
    });
    expect(sent).toEqual([]);
    expect(await held()).toEqual(before);
  });

  it("上限に達したら溜めずに印と落とした通数を残し、release を 409 で断る。状態を変える要求は断らない", async () => {
    const { fastify, store, sent, order, held } = await setup({ streamHoldLimit: 3 });
    await fastify.inject({ method: "POST", url: "/_control/stream/hold" });
    await order(); // 2 通
    const second = await order(); // 2 通。入りきらない
    // 発注そのものは通り、状態にも現れる。
    expect(second.json().success).toBe(1);
    expect(store.state().orders).toHaveLength(2);
    const fill = await fastify.inject({ method: "POST", url: "/_control/orders/1/fill" });
    expect(fill.statusCode).toBe(200);

    const body = await held();
    expect(body).toMatchObject({ holding: true, held: 2, limit: 3, overflowed: true });
    expect(body.dropped).toBeGreaterThan(2);
    expect(body.messages).toHaveLength(2);

    const release = await fastify.inject({ method: "POST", url: "/_control/stream/release" });
    expect(release.statusCode).toBe(409);
    expect(release.json()).toEqual({
      error: "STREAM_HOLD_OVERFLOWED",
      limit: 3,
      dropped: body.dropped,
    });
    expect(sent).toEqual([]);

    // 抜け出すのは reset。溜めたものを捨て、保留も解く。
    const reset = await fastify.inject({ method: "POST", url: "/_control/reset", payload: {} });
    expect(reset.statusCode).toBe(200);
    expect(await held()).toMatchObject({ holding: false, held: 0, overflowed: false, dropped: 0 });
  });

  it("reset は溜めたものを捨て、保留を解く", async () => {
    const { fastify, order, held } = await setup();
    await fastify.inject({ method: "POST", url: "/_control/stream/hold" });
    await order();
    await fastify.inject({ method: "POST", url: "/_control/reset", payload: {} });
    expect(await held()).toMatchObject({ holding: false, held: 0, messages: [] });
    const res = await fastify.inject({ method: "POST", url: "/_control/stream/release" });
    expect(res.json()).toEqual({ error: "NOT_HOLDING" });
  });

  it("保留は PaperState にも GET /_control/state にも現れない", async () => {
    const { fastify, store } = await setup();
    const before = store.state();
    await fastify.inject({ method: "POST", url: "/_control/stream/hold" });
    expect(store.state()).toBe(before);
    const state = await fastify.inject({ method: "GET", url: "/_control/state" });
    expect(Object.keys(state.json()).sort()).toEqual(
      [...Object.keys(before), "persist", "candles"].sort(),
    );
  });

  it.each([
    { method: "POST", url: "/_control/stream/hold" },
    { method: "GET", url: "/_control/stream/held" },
    { method: "POST", url: "/_control/stream/release" },
  ] as const)(
    "非ループバックからの $method $url はトークンが無ければ 403",
    async ({ method, url }) => {
      const { fastify } = await setup({ token: "secret" });
      const res = await fastify.inject({ method, url, remoteAddress: "10.0.0.8" });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: "FORBIDDEN" });
      expect(fastify.privateStream.holdStatus().holding).toBe(false);
    },
  );

  it("control を無効にすると 3 つとも 404", async () => {
    const { fastify } = await setup({ controlEnabled: false });
    for (const [method, url] of [
      ["POST", "/_control/stream/hold"],
      ["GET", "/_control/stream/held"],
      ["POST", "/_control/stream/release"],
    ] as const) {
      const res = await fastify.inject({ method, url });
      expect(res.statusCode).toBe(404);
    }
  });
});

/**
 * `applyFill` が失敗しても 500 にしない。かつては throw していたので、`runTick` を通る
 * 経路（`POST /_control/tick` と market モードの `SessionStore.tick()`）が
 * 封筒でない 500 を返していた。`/_control/` は 400、互換ルートは封筒を保つ。
 */
describe("runTick が約定を適用できないとき", () => {
  const SATURATED = Number.MAX_SAFE_INTEGER + 1;

  const stateWithSaturatedTradeSeq = () =>
    buildState({
      balances: { jpy: 10_000_000 },
      orders: [buildOrder({ id: "1", price: 5_000_000, startAmount: 0.001 })],
      nextTradeSeq: SATURATED,
    });

  it("POST /_control/tick は 500 ではなく 400 で断り、状態を変えない", async () => {
    const { fastify, store } = await buildControl(stateWithSaturatedTradeSeq());
    const before = store.state();
    const res = await fastify.inject({
      method: "POST",
      url: "/_control/tick",
      payload: { pair: "btc_jpy", price: 4_000_000 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "applyFill: TRADE_SEQ_EXHAUSTED" });
    expect(store.state()).toBe(before);
    await fastify.close();
  });

  it("market モードの互換ルートは封筒を保つ（読み取りは通る）", async () => {
    const candles = {
      btc_jpy: [
        {
          open: 4_000_000,
          high: 4_000_000,
          low: 4_000_000,
          close: 4_000_000,
          vol: 0,
          timestamp: Date.now() - 60_000,
        },
      ],
    };
    const store = new SessionStore(stateWithSaturatedTradeSeq(), {
      path: null,
      fillMode: "market",
      fetchCandles: async (pair) => ({
        success: true,
        data: pair === "btc_jpy" ? candles.btc_jpy : [],
      }),
    });
    const fastify = await buildServer({ store, logger: false, controlEnabled: false });

    const get = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/order?pair=btc_jpy&order_id=1",
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ success: 1 });

    // 劣化中も通す読み取り経路（注文状態の照合の主経路）も落ちない。
    const info = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/orders_info",
      payload: { pair: "btc_jpy", order_ids: [1] },
    });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toMatchObject({ success: 1 });

    const assets = await fastify.inject({ method: "GET", url: "/v1/user/assets" });
    expect(assets.statusCode).toBe(200);
    expect(assets.json()).toMatchObject({ success: 1 });
    await fastify.close();
  });
});
