import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { type IncomingHttpHeaders, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Candle } from "../../src/engine/candles.ts";
import { loadState } from "../../src/engine/persist.ts";
import { freshState, type PaperState } from "../../src/engine/state.ts";
import type { FetchCandles } from "../../src/engine/types.ts";
import type { FillMode } from "../../src/server/config.ts";
import { FaultInjector, serverErrorBody } from "../../src/server/faults.ts";
import { buildServer } from "../../src/server/http.ts";
import { SessionStore } from "../../src/store/session.ts";
import { buildOrder, buildState } from "../engine/helpers.ts";
import { connectStream, stubFetchCandles } from "../routes/helpers.ts";

/**
 * REST の障害注入（`src/server/faults.ts`。`docs/plan-lab-mock.md` 18.2 の決定 29〜34・36、
 * 挙動の正は `docs/fidelity.md` の「REST の障害注入」節）。
 *
 * `/_control/faults` の口の形（応答・400・403・404）は `tests/routes/control.test.ts` が見る。
 * ここは**故障が当たったときに互換ルートがどう振る舞うか**を見る。
 *
 * **応答不明（`no_response`）は実際に listen したサーバへ `node:http` で撃つ。** `inject()` の偽の
 * ソケットは閉じても応答を返してしまい、切れたことが見えない（外向きの要求ではないので
 * `tests/network-guard.ts` の対象外）。
 */

const ORDER = { pair: "btc_jpy", side: "buy", type: "limit", price: 5_000_000, amount: 0.001 };

type Built = { fastify: FastifyInstance; store: SessionStore };

describe("REST の障害注入", () => {
  let dir: string;
  const cleanups: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bitbank-mock-faults-"));
  });

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
    await rm(dir, { recursive: true, force: true });
  });

  async function build(
    opts: {
      state?: PaperState;
      fillMode?: FillMode;
      fetchCandles?: FetchCandles;
      /** 状態ファイルのパス。省けば書かない。 */
      path?: string | null;
      controlEnabled?: boolean;
    } = {},
  ): Promise<Built> {
    const store = new SessionStore(opts.state ?? buildState(), {
      path: opts.path ?? null,
      fillMode: opts.fillMode ?? "manual",
      feeRate: 0,
      fetchCandles: opts.fetchCandles ?? stubFetchCandles({}),
    });
    const fastify = await buildServer({
      store,
      logger: false,
      controlEnabled: opts.controlEnabled ?? true,
    });
    cleanups.push(() => fastify.close());
    return { fastify, store };
  }

  async function register(fastify: FastifyInstance, spec: Record<string, unknown>) {
    const res = await fastify.inject({ method: "POST", url: "/_control/faults", payload: spec });
    expect(res.statusCode).toBe(200);
    return res.json().fault as { id: number };
  }

  async function faults(fastify: FastifyInstance) {
    const res = await fastify.inject({ method: "GET", url: "/_control/faults" });
    return res.json().faults as Array<{ id: number; remaining: number; hits: number }>;
  }

  function placeOrder(fastify: FastifyInstance) {
    return fastify.inject({ method: "POST", url: "/v1/user/spot/order", payload: ORDER });
  }

  // --- 429（rate_limit） ---

  it("rate_limit は状態を変えずに HTTP 429 と封筒 10009 を返し、次の要求は通す", async () => {
    const { fastify, store } = await build();
    await register(fastify, { method: "POST", path: "/v1/user/spot/order", kind: "rate_limit" });
    const before = JSON.stringify(store.state());

    const limited = await placeOrder(fastify);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["content-type"]).toMatch(/^application\/json/);
    expect(limited.json()).toEqual({ success: 0, data: { code: 10009 } });
    expect(JSON.stringify(store.state())).toBe(before);

    const next = await placeOrder(fastify);
    expect(next.statusCode).toBe(200);
    expect(next.json().success).toBe(1);
    expect(store.state().orders).toHaveLength(1);
  });

  // ハンドラへ入る前に返すので、market モードの tick（足の取得と約定）も走らない。
  it("429 と 5xx はハンドラの前で返し、market モードでも足を取りに行かず約定させない", async () => {
    let fetched = 0;
    const candles: Candle[] = [];
    const fetchCandles: FetchCandles = async (pair, fromMs, toMs) => {
      fetched += 1;
      return stubFetchCandles({ btc_jpy: candles })(pair, fromMs, toMs);
    };
    const { fastify, store } = await build({
      fillMode: "market",
      fetchCandles,
      state: buildState({
        orders: [buildOrder({ id: "1", price: 5_000_000 })],
        lastTickAt: new Date(Date.now() - 120_000).toISOString(),
      }),
    });
    await register(fastify, {
      method: "GET",
      path: "/v1/user/assets",
      kind: "rate_limit",
    });
    await register(fastify, { method: "GET", path: "/v1/user/assets", kind: "server_error" });
    const before = JSON.stringify(store.state());

    expect((await fastify.inject({ method: "GET", url: "/v1/user/assets" })).statusCode).toBe(429);
    expect((await fastify.inject({ method: "GET", url: "/v1/user/assets" })).statusCode).toBe(500);
    expect(fetched).toBe(0);
    expect(JSON.stringify(store.state())).toBe(before);

    // 使い切った後は通常どおり tick が走る（対照）。
    expect((await fastify.inject({ method: "GET", url: "/v1/user/assets" })).statusCode).toBe(200);
    expect(fetched).toBeGreaterThan(0);
  });

  // --- 5xx（server_error） ---

  it("server_error は状態を変えずに 5xx を返す。本文は封筒でも JSON でもない", async () => {
    const { fastify, store } = await build();
    await register(fastify, { method: "POST", path: "/v1/user/spot/order", kind: "server_error" });
    await register(fastify, {
      method: "POST",
      path: "/v1/user/spot/order",
      kind: "server_error",
      status: 503,
    });

    const first = await placeOrder(fastify);
    expect(first.statusCode).toBe(500);
    expect(first.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(first.body).toBe("Internal Server Error");

    const second = await placeOrder(fastify);
    expect(second.statusCode).toBe(503);
    expect(second.body).toBe("Service Unavailable");

    expect(store.state().orders).toEqual([]);
  });

  it("本文は Node の理由句で、登録の無いステータスでは Server Error になる", () => {
    expect(serverErrorBody(502)).toBe("Bad Gateway");
    expect(serverErrorBody(504)).toBe("Gateway Timeout");
    expect(serverErrorBody(599)).toBe("Server Error");
  });

  // --- 状態を変えたうえで 5xx（server_error_after_apply） ---

  it("server_error_after_apply はハンドラを通して状態を変え、stream にも流したうえで 5xx を返す", async () => {
    const { fastify, store } = await build();
    await register(fastify, {
      method: "POST",
      path: "/v1/user/spot/order",
      kind: "server_error_after_apply",
      status: 502,
    });
    const stream = await connectStream(fastify);

    const res = await placeOrder(fastify);
    expect(res.statusCode).toBe(502);
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    // 状態を変えない 5xx と同じ形（決定 30）。応答からはどちらか区別できない。
    expect(res.body).toBe("Bad Gateway");

    expect(store.state().orders).toHaveLength(1);
    await stream.flush();
    expect(stream.methods()).toEqual(["spot_order_new", "asset_update"]);
    const active = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/active_orders?pair=btc_jpy",
    });
    expect(active.json().data.orders).toHaveLength(1);
    stream.ws.terminate();
  });

  // --- 当て方（決定 29・31） ---

  it("同じ（メソッド, パス）の登録は、登録した順に使い切る", async () => {
    const { fastify, store } = await build();
    await register(fastify, {
      method: "POST",
      path: "/v1/user/spot/order",
      kind: "rate_limit",
      count: 2,
    });
    await register(fastify, {
      method: "POST",
      path: "/v1/user/spot/order",
      kind: "server_error_after_apply",
    });

    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await placeOrder(fastify)).statusCode);
    expect(statuses).toEqual([429, 429, 500, 200]);
    // 3 本目（5xx だが状態は変わる）と 4 本目（通常）の 2 本が注文になる。
    expect(store.state().orders).toHaveLength(2);
    expect((await faults(fastify)).map(({ remaining, hits }) => ({ remaining, hits }))).toEqual([
      { remaining: 0, hits: 2 },
      { remaining: 0, hits: 1 },
    ]);
  });

  it("要求の中身に依らず当たる（壊れた本文にも当たり、回数を減らす）", async () => {
    const { fastify } = await build();
    await register(fastify, { method: "POST", path: "/v1/user/spot/order", kind: "rate_limit" });
    await register(fastify, {
      method: "POST",
      path: "/v1/user/spot/order",
      kind: "server_error_after_apply",
    });

    const broken = {
      method: "POST" as const,
      url: "/v1/user/spot/order",
      headers: { "content-type": "application/json" },
      payload: "{",
    };
    // 本文の解析より前で返すので、Fastify の 400 より先に 429 になる。
    expect((await fastify.inject(broken)).statusCode).toBe(429);
    // ハンドラの後で差し替える種類は、Fastify が返す 400 も 5xx に差し替える。
    const replaced = await fastify.inject(broken);
    expect(replaced.statusCode).toBe(500);
    expect(replaced.body).toBe("Internal Server Error");
    // 検証で断られる発注（封筒の失敗）にも当たる。
    expect((await faults(fastify)).every((f) => f.remaining === 0)).toBe(true);
  });

  it("メソッドが違えば当たらない。HEAD は GET と同じ鍵で当たる", async () => {
    const { fastify } = await build();
    await register(fastify, { method: "POST", path: "/v1/user/spot/order", kind: "rate_limit" });
    const got = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/order?pair=btc_jpy&order_id=1",
    });
    expect(got.statusCode).toBe(200);
    expect((await faults(fastify))[0]?.remaining).toBe(1);

    await register(fastify, { method: "GET", path: "/v1/user/assets", kind: "rate_limit" });
    const head = await fastify.inject({ method: "HEAD", url: "/v1/user/assets" });
    expect(head.statusCode).toBe(429);
  });

  it("経路の決まらない要求（未登録のパス）には当たらず、いつもの 404 / 封筒のまま", async () => {
    const { fastify } = await build();
    await register(fastify, { method: "GET", path: "/v1/user/assets", kind: "rate_limit" });
    const unknown = await fastify.inject({ method: "GET", url: "/v1/user/assetz" });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toEqual({ success: 0, data: { code: 20003 } });
    expect((await faults(fastify))[0]?.remaining).toBe(1);
  });

  it("GET /v1/user/subscribe にも当たる（互換ルートの 1 本として扱う）", async () => {
    const { fastify } = await build();
    await register(fastify, { method: "GET", path: "/v1/user/subscribe", kind: "server_error" });
    const res = await fastify.inject({ method: "GET", url: "/v1/user/subscribe" });
    expect(res.statusCode).toBe(500);
  });

  it("reset で登録を捨てる（使い残しを次のシナリオへ持ち越さない）", async () => {
    const { fastify } = await build();
    await register(fastify, {
      method: "POST",
      path: "/v1/user/spot/order",
      kind: "rate_limit",
      count: 3,
    });
    const reset = await fastify.inject({ method: "POST", url: "/_control/reset", payload: {} });
    expect(reset.statusCode).toBe(200);
    expect(await faults(fastify)).toEqual([]);
    expect((await placeOrder(fastify)).statusCode).toBe(200);
  });

  it("control が無効なら互換ルートに故障は掛からない（口も無い）", async () => {
    const { fastify } = await build({ controlEnabled: false });
    const res = await fastify.inject({ method: "POST", url: "/_control/faults", payload: {} });
    expect(res.statusCode).toBe(404);
    expect((await placeOrder(fastify)).statusCode).toBe(200);
  });

  // --- 応答不明（no_response）: 実際に listen したサーバで見る ---

  it("no_response は状態を変え、stream の配信と書き出しまで済ませてから、応答を返さずに切る", async () => {
    const path = join(dir, "state.json");
    const { fastify, store } = await build({ path });
    await register(fastify, { method: "POST", path: "/v1/user/spot/order", kind: "no_response" });
    const stream = await connectStream(fastify);
    const port = await listen(fastify);

    const res = await rawRequest(port, "POST", "/v1/user/spot/order", ORDER);
    expect(res).toMatchObject({ error: "socket hang up", code: "ECONNRESET" });

    expect(store.state().orders).toHaveLength(1);
    await stream.flush();
    expect(stream.methods()).toEqual(["spot_order_new", "asset_update"]);
    // 書き出しまで済んでいるので、再起動しても注文は残る。
    const saved = await loadState(path);
    expect(saved.success && saved.data?.orders).toHaveLength(1);

    // 次の要求は通常どおり応答が返る。
    const next = await rawRequest(port, "POST", "/v1/user/spot/order", ORDER);
    expect(next).toMatchObject({ status: 200 });
    stream.ws.terminate();
  });

  it("no_response を読み取りの口に当てると、応答だけが失われる", async () => {
    const { fastify, store } = await build();
    await register(fastify, { method: "GET", path: "/v1/user/assets", kind: "no_response" });
    const port = await listen(fastify);
    const before = JSON.stringify(store.state());
    expect(await rawRequest(port, "GET", "/v1/user/assets")).toMatchObject({
      code: "ECONNRESET",
    });
    expect(JSON.stringify(store.state())).toBe(before);
    expect(await rawRequest(port, "GET", "/v1/user/assets")).toMatchObject({ status: 200 });
  });

  // 決定 36: 保留との間に特例は無い。応答不明にした変化のメッセージも溜まる。
  it("保留中の no_response は、その変化のメッセージを溜める（release で届く）", async () => {
    const { fastify, store } = await build();
    await register(fastify, { method: "POST", path: "/v1/user/spot/order", kind: "no_response" });
    const stream = await connectStream(fastify);
    const port = await listen(fastify);
    await fastify.inject({ method: "POST", url: "/_control/stream/hold" });

    expect(await rawRequest(port, "POST", "/v1/user/spot/order", ORDER)).toMatchObject({
      code: "ECONNRESET",
    });
    expect(store.state().orders).toHaveLength(1);
    await stream.flush();
    expect(stream.messages).toEqual([]);

    const held = await fastify.inject({ method: "GET", url: "/_control/stream/held" });
    expect(held.json().held).toBe(2);
    await fastify.inject({ method: "POST", url: "/_control/stream/release" });
    await stream.flush();
    expect(stream.methods()).toEqual(["spot_order_new", "asset_update"]);
    stream.ws.terminate();
  });

  // --- 劣化中（決定 34）: 故障を先に当て、回数も減らす ---

  /** 書き出しが必ず失敗する（状態ファイルのパスがディレクトリの）サーバ。 */
  async function buildDegraded(): Promise<Built> {
    const path = join(dir, "degraded", "state.json");
    await mkdir(path, { recursive: true });
    const built = await build({ path, state: freshState(10_000_000) });
    await built.store.persist();
    expect(built.store.isDegraded()).toBe(true);
    return built;
  }

  it("劣化中も故障を先に当てる。429 と 5xx は 70001 より先に出て、回数も減る", async () => {
    const { fastify } = await buildDegraded();
    // 劣化中も登録は通る（状態ファイルに書かない control の口）。
    await register(fastify, { method: "POST", path: "/v1/user/spot/order", kind: "rate_limit" });
    await register(fastify, { method: "POST", path: "/v1/user/spot/order", kind: "server_error" });
    await register(fastify, {
      method: "POST",
      path: "/v1/user/spot/order",
      kind: "server_error_after_apply",
    });

    expect((await placeOrder(fastify)).statusCode).toBe(429);
    expect((await placeOrder(fastify)).statusCode).toBe(500);
    // ハンドラへ入れず 70001 を返す要求も、状態を変えないまま 5xx に差し替える。
    const replaced = await placeOrder(fastify);
    expect(replaced.statusCode).toBe(500);
    expect(replaced.body).toBe("Internal Server Error");
    // 使い切った後は劣化の応答に戻る。
    expect((await placeOrder(fastify)).json()).toEqual({ success: 0, data: { code: 70001 } });
    // 劣化中も一覧と取消は通る（状態ファイルに書かない control の口）。
    expect((await faults(fastify)).map((f) => f.hits)).toEqual([1, 1, 1]);
    const one = await fastify.inject({ method: "DELETE", url: "/_control/faults/1" });
    expect(one.statusCode).toBe(200);
    const all = await fastify.inject({ method: "DELETE", url: "/_control/faults" });
    expect(all.json()).toEqual({ removed: 2 });
  });

  it("劣化中の no_response は、劣化の判定が返した応答を送らずに切る", async () => {
    const { fastify, store } = await buildDegraded();
    await register(fastify, { method: "POST", path: "/v1/user/spot/order", kind: "no_response" });
    const port = await listen(fastify);
    expect(await rawRequest(port, "POST", "/v1/user/spot/order", ORDER)).toMatchObject({
      code: "ECONNRESET",
    });
    expect(store.state().orders).toEqual([]);
  });
});

describe("FaultInjector", () => {
  function injector() {
    const store = new SessionStore(buildState(), { path: null, fillMode: "manual" });
    const faults = new FaultInjector(store);
    faults.addRoute("POST", "/v1/user/spot/order");
    faults.addRoute("GET", "/v1/user/spot/order");
    faults.addRoute("HEAD", "/v1/user/spot/order");
    faults.addRoute("GET", "/v1/user/assets");
    faults.addRoute("GET", "/_control/state");
    faults.addRoute("GET", "/_stream/private");
    return { store, faults };
  }

  it("故障を当てられるのは互換ルートだけで、HEAD は GET と同じ鍵に畳む", () => {
    const { faults } = injector();
    expect(faults.targetKeys()).toEqual([
      "GET /v1/user/assets",
      "GET /v1/user/spot/order",
      "POST /v1/user/spot/order",
    ]);
  });

  it("省いた値の既定と、種類ごとの status", () => {
    const { faults } = injector();
    const path = "/v1/user/spot/order";
    const kinds = ["rate_limit", "server_error", "no_response", "server_error_after_apply"];
    const views = kinds.map((kind) => {
      const r = faults.register({ method: "POST", path, kind });
      if (!r.success) throw new Error(r.error);
      return r.data;
    });
    expect(views.map((v) => [v.id, v.kind, v.status, v.count, v.remaining, v.hits])).toEqual([
      [1, "rate_limit", 429, 1, 1, 0],
      [2, "server_error", 500, 1, 1, 0],
      [3, "no_response", null, 1, 1, 0],
      [4, "server_error_after_apply", 500, 1, 1, 0],
    ]);
  });

  it("HEAD で登録しても GET の登録になる", () => {
    const { faults } = injector();
    const r = faults.register({ method: "HEAD", path: "/v1/user/assets", kind: "rate_limit" });
    expect(r.success && r.data.method).toBe("GET");
    expect(faults.take("GET", "/v1/user/assets")).toEqual({ kind: "rate_limit" });
  });

  const target = { method: "POST", path: "/v1/user/spot/order" };

  it.each([
    ["本文がオブジェクトでない", [target]],
    ["本文が無い", undefined],
    ["知らないキーがある", { ...target, kind: "rate_limit", cnt: 2 }],
    ["kind が無い", { ...target }],
    ["kind が知らない値", { ...target, kind: "timeout" }],
    ["method が文字列でない", { method: 1, path: target.path, kind: "rate_limit" }],
    ["path が文字列でない", { method: "POST", path: null, kind: "rate_limit" }],
    ["count が 0", { ...target, kind: "rate_limit", count: 0 }],
    ["count が負", { ...target, kind: "rate_limit", count: -1 }],
    ["count が整数でない", { ...target, kind: "rate_limit", count: 1.5 }],
    ["count が文字列", { ...target, kind: "rate_limit", count: "1" }],
    ["count が安全な整数を超える", { ...target, kind: "rate_limit", count: 2 ** 53 }],
    ["status が 5xx でない", { ...target, kind: "server_error", status: 499 }],
    ["status が 599 を超える", { ...target, kind: "server_error", status: 600 }],
    ["status が文字列", { ...target, kind: "server_error", status: "503" }],
    ["status が null", { ...target, kind: "server_error", status: null }],
    ["rate_limit に status", { ...target, kind: "rate_limit", status: 503 }],
    ["no_response に status", { ...target, kind: "no_response", status: 500 }],
  ])("%s なら INVALID_FAULT", (_, body) => {
    const { faults } = injector();
    expect(faults.register(body)).toEqual({ success: false, error: "INVALID_FAULT" });
    expect(faults.list()).toEqual([]);
  });

  it.each([
    ["control の口", { method: "GET", path: "/_control/state" }],
    ["private stream の口", { method: "GET", path: "/_stream/private" }],
    ["互換ルートに無いパス", { method: "POST", path: "/v1/user/spot/amend_order" }],
    ["メソッドが違う", { method: "DELETE", path: "/v1/user/spot/order" }],
    ["メソッドが小文字", { method: "post", path: "/v1/user/spot/order" }],
    ["クエリ付き", { method: "GET", path: "/v1/user/spot/order?pair=btc_jpy" }],
  ])("%s なら INVALID_FAULT_TARGET", (_, t) => {
    const { faults } = injector();
    expect(faults.register({ ...t, kind: "rate_limit" })).toEqual({
      success: false,
      error: "INVALID_FAULT_TARGET",
    });
  });

  it("残り回数が 0 になっても一覧に残し、取消と reset で消える。id は振り直さない", async () => {
    const { store, faults } = injector();
    faults.start();
    faults.register({ ...target, kind: "rate_limit" });
    faults.register({ ...target, kind: "server_error" });
    expect(faults.take("POST", target.path)?.kind).toBe("rate_limit");
    expect(faults.take("POST", target.path)?.kind).toBe("server_error");
    expect(faults.take("POST", target.path)).toBeNull();
    expect(faults.list().map((f) => [f.id, f.remaining, f.hits])).toEqual([
      [1, 0, 1],
      [2, 0, 1],
    ]);

    expect(faults.cancel(1)?.id).toBe(1);
    expect(faults.cancel(1)).toBeNull();
    expect(faults.list().map((f) => f.id)).toEqual([2]);

    await store.reset(freshState(10_000_000));
    expect(faults.list()).toEqual([]);
    const again = faults.register({ ...target, kind: "rate_limit" });
    expect(again.success && again.data.id).toBe(3);

    expect(faults.clear()).toBe(1);
    expect(faults.list()).toEqual([]);
    faults.stop();
  });

  it("stop した後の reset では捨てない（購読を外している）", async () => {
    const { store, faults } = injector();
    faults.start();
    faults.start();
    faults.stop();
    faults.register({ ...target, kind: "rate_limit" });
    await store.reset(freshState(10_000_000));
    expect(faults.list()).toHaveLength(1);
  });
});

/** ループバックの空きポートで listen させ、ポートを返す。 */
async function listen(fastify: FastifyInstance): Promise<number> {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  const address = fastify.server.address();
  if (address === null || typeof address === "string") throw new Error("listen していない");
  return address.port;
}

type RawResult =
  | { status: number; headers: IncomingHttpHeaders; body: string }
  | { error: string; code: string | undefined };

/**
 * `node:http` で 1 本撃つ。接続を使い回さない（`agent: false`）——切られた接続を次の要求が
 * 拾うと、どちらの要求の結果か読めなくなる。
 */
function rawRequest(port: number, method: string, path: string, body?: unknown) {
  return new Promise<RawResult>((resolve) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        agent: false,
        headers: payload === undefined ? {} : { "content-type": "application/json" },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
        );
      },
    );
    req.on("error", (e: NodeJS.ErrnoException) => resolve({ error: e.message, code: e.code }));
    req.end(payload);
  });
}
