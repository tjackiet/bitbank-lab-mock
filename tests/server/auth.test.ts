import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshState } from "../../src/engine/state.ts";
import {
  type AuthRequest,
  AuthVerifier,
  DEFAULT_TIME_WINDOW_MS,
  MAX_REQUEST_TIME_AHEAD_MS,
  MAX_TIME_WINDOW_MS,
  readRawBody,
} from "../../src/server/auth.ts";
import type { ApiCredentials } from "../../src/server/config.ts";
import { buildServer } from "../../src/server/http.ts";
import { SessionStore } from "../../src/store/session.ts";
import { buildState } from "../engine/helpers.ts";
import { connectStream, stubFetchCandles } from "../routes/helpers.ts";
import { hmacHex, nonceHeaders, OFFICIAL_SAMPLES, timeWindowHeaders } from "./auth-sign.ts";

/**
 * 認証ヘッダの検証（`src/server/auth.ts`。`docs/plan-lab-mock.md` 19.2 の決定 37〜43、挙動の正は
 * `docs/fidelity.md` の「認証」節）。
 *
 * 署名は `tests/server/auth-sign.ts` が**公式の記述だけから**作る。その関数が公式のサンプルと同じ
 * 署名を出すことを最初に確かめ、残りはその関数で作った要求を投げる。
 *
 * 検証を有効にしないときの挙動（ヘッダ無しで通る）は、**既存のテストが修正なしで通ること**で
 * 見ている（`tests/routes/` の全件が認証ヘッダを付けずに互換ルートを叩く）。ここでは明示の
 * `null` と、環境変数からの既定の 2 つだけを足す。起動時の配線（片方だけなら起動しない・ログ）は
 * `tests/index.test.ts` が子プロセスで見る。
 */

const KEY = "test-key";
const SECRET = "test-secret";
const CREDS: ApiCredentials = { key: KEY, secret: SECRET };

/** ヘッダ名を Node の `IncomingHttpHeaders` と同じ小文字にする。 */
const lower = (h: Record<string, string>) =>
  Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

const getReq = (rawUrl: string, headers: Record<string, string>): AuthRequest => ({
  rawUrl,
  body: undefined,
  headers: lower(headers),
});

const postReq = (body: string, headers: Record<string, string>): AuthRequest => ({
  rawUrl: "/v1/user/spot/order",
  body: Buffer.from(body),
  headers: lower(headers),
});

describe("テスト用の署名（tests/server/auth-sign.ts）", () => {
  // 公式のサンプルと 1 文字でも違えば、以下のテストはモックの実装ではなく自分の誤りを見ることになる。
  it("公式のサンプル 4 つと同じ署名を出す", () => {
    const s = OFFICIAL_SAMPLES;
    const tw = (target: { path: string } | { body: string }) =>
      timeWindowHeaders({
        key: "k",
        secret: s.secret,
        requestTime: s.requestTime,
        timeWindow: s.timeWindow,
        target,
      })["ACCESS-SIGNATURE"];
    const nonce = (target: { path: string } | { body: string }) =>
      nonceHeaders({ key: "k", secret: s.secret, nonce: s.nonce, target })["ACCESS-SIGNATURE"];
    expect(tw({ path: s.path })).toBe(s.signatures.timeWindowGet);
    expect(tw({ body: s.body })).toBe(s.signatures.timeWindowPost);
    expect(nonce({ path: s.path })).toBe(s.signatures.nonceGet);
    expect(nonce({ body: s.body })).toBe(s.signatures.noncePost);
  });
});

describe("AuthVerifier", () => {
  const NOW = 1_800_000_000_000;
  const verifier = (now = NOW) => new AuthVerifier(CREDS, { now: () => now });
  const tw = (requestTime: number | string, target: { path: string } | { body: string }) =>
    timeWindowHeaders({ key: KEY, secret: SECRET, requestTime: String(requestTime), target });
  const nonce = (n: string, target: { path: string } | { body: string }) =>
    nonceHeaders({ key: KEY, secret: SECRET, nonce: n, target });

  it("公式のサンプルの署名を、両方の方式・GET と POST で受け付ける", () => {
    const s = OFFICIAL_SAMPLES;
    const at = Number(s.requestTime);
    const v = new AuthVerifier({ key: "k", secret: s.secret }, { now: () => at });
    const base = { "ACCESS-KEY": "k" };
    const timeWindow = {
      ...base,
      "ACCESS-REQUEST-TIME": s.requestTime,
      "ACCESS-TIME-WINDOW": s.timeWindow,
    };
    expect(
      v.verify(getReq(s.path, { ...timeWindow, "ACCESS-SIGNATURE": s.signatures.timeWindowGet })),
    ).toEqual({ ok: true });
    expect(
      v.verify(postReq(s.body, { ...timeWindow, "ACCESS-SIGNATURE": s.signatures.timeWindowPost })),
    ).toEqual({ ok: true });
    // nonce は増え続ける必要があるので、GET と POST のサンプル（同じ nonce）は別の検証器で受ける。
    const nonceBase = { ...base, "ACCESS-NONCE": s.nonce };
    expect(
      v.verify(getReq(s.path, { ...nonceBase, "ACCESS-SIGNATURE": s.signatures.nonceGet })),
    ).toEqual({ ok: true });
    const v2 = new AuthVerifier({ key: "k", secret: s.secret }, { now: () => at });
    expect(
      v2.verify(postReq(s.body, { ...nonceBase, "ACCESS-SIGNATURE": s.signatures.noncePost })),
    ).toEqual({ ok: true });
  });

  it("失敗ごとに認証の系統のコードと理由を返す", () => {
    const path = "/v1/user/assets";
    const good = tw(NOW, { path });
    const without = (h: Record<string, string>, name: string) =>
      Object.fromEntries(Object.entries(h).filter(([k]) => k !== name));
    const cases: Array<[string, Record<string, string>, number, string]> = [
      ["ヘッダが 1 つも無い", {}, 20003, "missing ACCESS-KEY"],
      ["ACCESS-KEY が空文字", { ...good, "ACCESS-KEY": "" }, 20003, "missing ACCESS-KEY"],
      ["ACCESS-KEY が違う", { ...good, "ACCESS-KEY": "other" }, 20002, "unknown ACCESS-KEY"],
      [
        "ACCESS-TIME-WINDOW だけで時刻が無い",
        without(good, "ACCESS-REQUEST-TIME"),
        20033,
        "missing ACCESS-REQUEST-TIME",
      ],
      [
        "時刻が整数でない（小数）",
        { ...good, "ACCESS-REQUEST-TIME": "1800000000000.5" },
        20034,
        "invalid ACCESS-REQUEST-TIME",
      ],
      [
        "時刻が整数でない（負）",
        { ...good, "ACCESS-REQUEST-TIME": "-1" },
        20034,
        "invalid ACCESS-REQUEST-TIME",
      ],
      [
        "窓が整数でない",
        { ...good, "ACCESS-TIME-WINDOW": "5e3" },
        20001,
        "invalid ACCESS-TIME-WINDOW",
      ],
      [
        "窓が上限を超える",
        timeWindowHeaders({
          key: KEY,
          secret: SECRET,
          requestTime: String(NOW),
          timeWindow: String(MAX_TIME_WINDOW_MS + 1),
          target: { path },
        }),
        20001,
        "invalid ACCESS-TIME-WINDOW",
      ],
      [
        "時刻の窓の外（古い）",
        tw(NOW - DEFAULT_TIME_WINDOW_MS - 1, { path }),
        20034,
        "ACCESS-REQUEST-TIME outside the time window",
      ],
      [
        "nonce 方式で nonce が無い",
        without(nonce("1", { path }), "ACCESS-NONCE"),
        20004,
        "missing ACCESS-NONCE",
      ],
      ["nonce が整数でない", nonce("1.5", { path }), 20001, "invalid ACCESS-NONCE"],
      ["署名が無い", without(good, "ACCESS-SIGNATURE"), 20005, "missing ACCESS-SIGNATURE"],
      [
        "署名が違う（別のシークレット）",
        timeWindowHeaders({
          key: KEY,
          secret: "other",
          requestTime: String(NOW),
          target: { path },
        }),
        20005,
        "signature mismatch",
      ],
      [
        "署名が 16 進の大文字",
        { ...good, "ACCESS-SIGNATURE": good["ACCESS-SIGNATURE"]!.toUpperCase() },
        20005,
        "signature mismatch",
      ],
      [
        "署名が 16 進でない",
        { ...good, "ACCESS-SIGNATURE": "z".repeat(64) },
        20005,
        "signature mismatch",
      ],
    ];
    for (const [label, headers, code, reason] of cases) {
      expect(verifier().verify(getReq(path, headers)), label).toEqual({ ok: false, code, reason });
    }
  });

  it("時刻の窓は公式の判定式どおり（未来は 1000 ミリ秒未満、過去は窓の幅ちょうどまで）", () => {
    const path = "/v1/user/assets";
    const ok = (t: number, timeWindow = "5000") =>
      verifier().verify(
        getReq(
          path,
          timeWindowHeaders({
            key: KEY,
            secret: SECRET,
            requestTime: String(t),
            timeWindow,
            target: { path },
          }),
        ),
      ).ok;
    expect(ok(NOW)).toBe(true);
    expect(ok(NOW - 5000)).toBe(true);
    expect(ok(NOW - 5001)).toBe(false);
    expect(ok(NOW + MAX_REQUEST_TIME_AHEAD_MS - 1)).toBe(true);
    expect(ok(NOW + MAX_REQUEST_TIME_AHEAD_MS)).toBe(false);
    // 上限ちょうどは受け、窓 0 は「サーバの時刻以後」だけを受ける。
    expect(ok(NOW - MAX_TIME_WINDOW_MS, String(MAX_TIME_WINDOW_MS))).toBe(true);
    expect(ok(NOW, "0")).toBe(true);
    expect(ok(NOW - 1, "0")).toBe(false);
  });

  /**
   * 窓を省いたとき（公式「未指定の場合デフォルトで 5000」）。署名対象に何を連結するかは公式に
   * 書かれていないので、モックは既定値の `5000` を連結したものとして見る（推測。
   * `docs/fidelity.md` の「認証」節）。
   */
  it("ACCESS-TIME-WINDOW を省くと窓は 5000 で、署名対象には 5000 を連結したものとして見る", () => {
    const path = "/v1/user/assets";
    const omitted = (t: number, signedWindow: string) => {
      const message = String(t) + signedWindow + path;
      return verifier().verify(
        getReq(path, {
          "ACCESS-KEY": KEY,
          "ACCESS-REQUEST-TIME": String(t),
          "ACCESS-SIGNATURE": hmacHex(SECRET, message),
        }),
      );
    };
    expect(omitted(NOW - 5000, "5000")).toEqual({ ok: true });
    expect(omitted(NOW - 5001, "5000")).toMatchObject({ ok: false, code: 20034 });
    expect(omitted(NOW, "")).toMatchObject({ ok: false, code: 20005 });
  });

  it("時刻と nonce の両方があれば ACCESS-TIME-WINDOW 方式で見る（nonce は使わない）", () => {
    const path = "/v1/user/assets";
    const v = verifier();
    const headers = { ...tw(NOW, { path }), "ACCESS-NONCE": "not-a-number" };
    expect(v.verify(getReq(path, headers))).toEqual({ ok: true });
    // 窓だけでも ACCESS-TIME-WINDOW 方式になり、時刻が無いので断る（nonce 方式へ落とさない）。
    const windowOnly = { ...nonce("1", { path }), "ACCESS-TIME-WINDOW": "5000" };
    expect(v.verify(getReq(path, windowOnly))).toMatchObject({ ok: false, code: 20033 });
  });

  it("nonce は前回受け付けた値より大きくなければ断り、署名の合った要求だけを数える", () => {
    const path = "/v1/user/assets";
    const v = verifier();
    const send = (n: string, secret = SECRET) =>
      v.verify(getReq(path, nonceHeaders({ key: KEY, secret, nonce: n, target: { path } })));
    expect(send("10")).toEqual({ ok: true });
    expect(send("10")).toEqual({ ok: false, code: 20001, reason: "ACCESS-NONCE not increasing" });
    expect(send("9")).toMatchObject({ ok: false, code: 20001 });
    // 署名の合わない要求は記録を動かさない。100 で断られた後も 11 が通る。
    expect(send("100", "other")).toMatchObject({ ok: false, code: 20005 });
    expect(send("11")).toEqual({ ok: true });
    // 安全な整数を超える nonce も桁を落とさずに比べる（Number では 2 つが同じ値になる）。
    expect(send("9007199254740992")).toEqual({ ok: true });
    expect(send("9007199254740993")).toEqual({ ok: true });
  });

  it("ACCESS-TIME-WINDOW 方式は nonce の記録に触れない", () => {
    const path = "/v1/user/assets";
    const v = verifier();
    const n = (x: string) =>
      v.verify(
        getReq(path, nonceHeaders({ key: KEY, secret: SECRET, nonce: x, target: { path } })),
      );
    expect(n("5")).toEqual({ ok: true });
    expect(v.verify(getReq(path, tw(NOW, { path })))).toEqual({ ok: true });
    expect(v.verify(getReq(path, tw(NOW, { path })))).toEqual({ ok: true });
    expect(n("6")).toEqual({ ok: true });
  });

  it("GET はパスとクエリを生のまま、POST は本文のバイト列を生のまま比べる", () => {
    const v = verifier();
    const signedUrl = "/v1/user/spot/order?pair=btc_jpy&order_id=1";
    const headers = tw(NOW, { path: signedUrl });
    expect(v.verify(getReq(signedUrl, headers))).toEqual({ ok: true });
    // 同じ意味でも、並びを変えたクエリ・`/v1` の無いパスは合わない。
    expect(v.verify(getReq("/v1/user/spot/order?order_id=1&pair=btc_jpy", headers))).toMatchObject({
      ok: false,
      code: 20005,
    });
    expect(v.verify(getReq("/user/spot/order?pair=btc_jpy&order_id=1", headers))).toMatchObject({
      ok: false,
      code: 20005,
    });

    const body = '{"pair":"btc_jpy","amount":"0.001"}';
    const signed = tw(NOW, { body });
    expect(v.verify(postReq(body, signed))).toEqual({ ok: true });
    expect(v.verify(postReq('{"pair": "btc_jpy","amount":"0.001"}', signed))).toMatchObject({
      ok: false,
      code: 20005,
    });
    expect(v.verify(postReq('{"amount":"0.001","pair":"btc_jpy"}', signed))).toMatchObject({
      ok: false,
      code: 20005,
    });
  });
});

describe("readRawBody", () => {
  it("届いたバイト列をそのまま繋いで返す", async () => {
    const s = new PassThrough();
    const read = readRawBody(s, 100, Number.NaN);
    s.write(Buffer.from('{"a": '));
    s.end(Buffer.from("1}"));
    expect((await read).toString()).toBe('{"a": 1}');
  });

  it("content-length が上限を超えていれば読まずに 413 の誤りで断る", async () => {
    const s = new PassThrough();
    await expect(readRawBody(s, 10, 11)).rejects.toMatchObject({
      code: "FST_ERR_CTP_BODY_TOO_LARGE",
      statusCode: 413,
    });
  });

  it("読んだ量が上限を超えたら 413 の誤りで断る（content-length の無い要求）", async () => {
    const s = new PassThrough();
    const read = readRawBody(s, 10, Number.NaN);
    s.write(Buffer.alloc(6));
    s.write(Buffer.alloc(6));
    await expect(read).rejects.toMatchObject({ code: "FST_ERR_CTP_BODY_TOO_LARGE" });
  });

  it("読み取りの失敗はそのまま返す", async () => {
    const s = new PassThrough();
    const read = readRawBody(s, 10, Number.NaN);
    s.destroy(new Error("aborted"));
    await expect(read).rejects.toThrow("aborted");
  });
});

describe("認証ヘッダの検証（HTTP）", () => {
  const ORDER = { pair: "btc_jpy", side: "buy", type: "limit", price: 5_000_000, amount: 0.001 };
  const ORDER_BODY = JSON.stringify(ORDER);

  let dir: string;
  const cleanups: Array<() => Promise<void>> = [];
  /** nonce は増え続ける必要があるので、テストの間で 1 つの数列を使う。 */
  let nextNonce = BigInt(Date.now()) * 1000n;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bitbank-mock-auth-"));
  });

  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
    await rm(dir, { recursive: true, force: true });
  });

  async function build(
    opts: { apiCredentials?: ApiCredentials | null; path?: string | null } = {},
  ): Promise<{ fastify: FastifyInstance; store: SessionStore }> {
    const store = new SessionStore(opts.path ? freshState(10_000_000) : buildState(), {
      path: opts.path ?? null,
      fillMode: "manual",
      feeRate: 0,
      fetchCandles: stubFetchCandles({}),
    });
    const fastify = await buildServer({
      store,
      logger: false,
      controlEnabled: true,
      streamAssetKeys: "camel",
      ...("apiCredentials" in opts
        ? { apiCredentials: opts.apiCredentials }
        : { apiCredentials: CREDS }),
    });
    cleanups.push(() => fastify.close());
    return { fastify, store };
  }

  const tw = (target: { path: string } | { body: string }, requestTime = Date.now()) =>
    timeWindowHeaders({ key: KEY, secret: SECRET, requestTime: String(requestTime), target });
  const nonce = (target: { path: string } | { body: string }) =>
    nonceHeaders({ key: KEY, secret: SECRET, nonce: String(nextNonce++), target });

  const get = (fastify: FastifyInstance, url: string, headers: Record<string, string> = {}) =>
    fastify.inject({ method: "GET", url, headers });
  const post = (
    fastify: FastifyInstance,
    url: string,
    body: string,
    headers: Record<string, string> = {},
  ) =>
    fastify.inject({
      method: "POST",
      url,
      payload: body,
      headers: { "content-type": "application/json", ...headers },
    });

  it("正しい署名なら、両方の方式で GET（クエリ付き）が通る", async () => {
    const { fastify } = await build();
    const url = "/v1/user/spot/active_orders?pair=btc_jpy&count=10";
    for (const headers of [tw({ path: url }), nonce({ path: url })]) {
      const res = await get(fastify, url, headers);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: 1, data: { orders: [] } });
    }
    const assets = await get(fastify, "/v1/user/assets", nonce({ path: "/v1/user/assets" }));
    expect(assets.json().success).toBe(1);
  });

  it("正しい署名なら、両方の方式で POST（本文付き）が通り、状態が変わる", async () => {
    const { fastify, store } = await build();
    const first = await post(fastify, "/v1/user/spot/order", ORDER_BODY, tw({ body: ORDER_BODY }));
    expect(first.json()).toMatchObject({ success: 1, data: { order_id: 1 } });
    const second = await post(
      fastify,
      "/v1/user/spot/order",
      ORDER_BODY,
      nonce({ body: ORDER_BODY }),
    );
    expect(second.json()).toMatchObject({ success: 1, data: { order_id: 2 } });
    expect(store.state().orders).toHaveLength(2);
    // 本文を読み直して渡しているので、ハンドラは同じ値を見ている（取消も通る）。
    const cancel = JSON.stringify({ pair: "btc_jpy", order_id: 1 });
    const canceled = await post(
      fastify,
      "/v1/user/spot/cancel_order",
      cancel,
      nonce({ body: cancel }),
    );
    expect(canceled.json()).toMatchObject({ success: 1, data: { status: "CANCELED_UNFILLED" } });
  });

  it("本文は空白やキーの順を含めて生のまま比べる（署名した通りの形なら通る）", async () => {
    const { fastify, store } = await build();
    const spaced =
      '{"pair": "btc_jpy", "side":"buy","type": "limit","price":5000000,"amount":0.001}';
    const reordered = JSON.stringify({
      amount: 0.001,
      price: 5_000_000,
      type: "limit",
      side: "buy",
      pair: "btc_jpy",
    });
    // ORDER_BODY に署名して、意味の同じ別の形を送る → 断る。
    for (const sent of [spaced, reordered]) {
      const res = await post(fastify, "/v1/user/spot/order", sent, tw({ body: ORDER_BODY }));
      expect(res.json()).toEqual({ success: 0, data: { code: 20005 } });
    }
    expect(store.state().orders).toEqual([]);
    // 空白を含む形でも、その形に署名していれば通る（モックは本文を整形し直さない）。
    const ok = await post(fastify, "/v1/user/spot/order", spaced, tw({ body: spaced }));
    expect(ok.json().success).toBe(1);
  });

  it("クエリは生のまま比べる（並びを変えると合わない）", async () => {
    const { fastify } = await build();
    const signed = "/v1/user/spot/active_orders?pair=btc_jpy&count=10";
    const sent = "/v1/user/spot/active_orders?count=10&pair=btc_jpy";
    const res = await get(fastify, sent, tw({ path: signed }));
    expect(res.json()).toEqual({ success: 0, data: { code: 20005 } });
  });

  /**
   * 断るときは HTTP 200 + 封筒で、状態を変えず、登録した故障の回数を減らさない（決定 42）。
   * 断った後に正しい署名の要求を送ると、登録した故障がそちらに当たる——回数が残っていた証拠。
   */
  it.each<[string, () => Record<string, string>, number]>([
    ["ヘッダが無い", () => ({}), 20003],
    ["キーが違う", () => ({ ...tw({ body: ORDER_BODY }), "ACCESS-KEY": "other" }), 20002],
    [
      "署名が違う",
      () =>
        timeWindowHeaders({
          key: KEY,
          secret: "other",
          requestTime: String(Date.now()),
          target: { body: ORDER_BODY },
        }),
      20005,
    ],
    ["時刻の窓の外", () => tw({ body: ORDER_BODY }, Date.now() - 60_000), 20034],
  ])("%s要求は断り、状態も故障の回数も変えない", async (_label, headers, code) => {
    const { fastify, store } = await build();
    const registered = await fastify.inject({
      method: "POST",
      url: "/_control/faults",
      payload: { method: "POST", path: "/v1/user/spot/order", kind: "rate_limit" },
    });
    expect(registered.statusCode).toBe(200);
    const before = JSON.stringify(store.state());

    const res = await post(fastify, "/v1/user/spot/order", ORDER_BODY, headers());
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.json()).toEqual({ success: 0, data: { code } });
    expect(JSON.stringify(store.state())).toBe(before);
    const faults = await fastify.inject({ method: "GET", url: "/_control/faults" });
    expect(faults.json().faults).toMatchObject([{ remaining: 1, hits: 0 }]);

    const limited = await post(
      fastify,
      "/v1/user/spot/order",
      ORDER_BODY,
      tw({ body: ORDER_BODY }),
    );
    expect(limited.statusCode).toBe(429);
    expect(JSON.stringify(store.state())).toBe(before);
  });

  it("GET /v1/user/subscribe も認証を求める", async () => {
    const { fastify } = await build();
    expect((await get(fastify, "/v1/user/subscribe")).json()).toEqual({
      success: 0,
      data: { code: 20003 },
    });
    const ok = await get(fastify, "/v1/user/subscribe", tw({ path: "/v1/user/subscribe" }));
    expect(ok.json().success).toBe(1);
  });

  it("/_control/ と /_stream/private は、有効にしても認証を求めない", async () => {
    const { fastify } = await build();
    const state = await get(fastify, "/_control/state");
    expect(state.statusCode).toBe(200);
    expect(state.json()).toHaveProperty("orders");
    const reset = await fastify.inject({ method: "POST", url: "/_control/reset" });
    expect(reset.statusCode).toBe(200);
    // WebSocket はヘッダ無しで繋がり、互換ルートの変化が届く。
    const stream = await connectStream(fastify);
    await post(fastify, "/v1/user/spot/order", ORDER_BODY, tw({ body: ORDER_BODY }));
    await stream.flush();
    expect(stream.methods()).toContain("spot_order_new");
    stream.ws.terminate();
  });

  // 未登録パスは検証の対象外で、ヘッダの有無に依らず従来どおり 20003（決定 41）。
  it("未登録の /v1/user/ パスは検証せず、従来どおり 20003 を返す", async () => {
    const { fastify } = await build();
    for (const headers of [{}, tw({ path: "/v1/user/spot/ping" })]) {
      const res = await get(fastify, "/v1/user/spot/ping", headers);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: 0, data: { code: 20003 } });
    }
  });

  it("書き出しに失敗した後の劣化中も、認証の失敗が 70001 より先に出る", async () => {
    const path = join(dir, "degraded", "state.json");
    await mkdir(path, { recursive: true });
    const { fastify, store } = await build({ path });
    await store.persist();
    expect(store.isDegraded()).toBe(true);

    const unsigned = await post(fastify, "/v1/user/spot/order", ORDER_BODY);
    expect(unsigned.json()).toEqual({ success: 0, data: { code: 20003 } });
    const signed = await post(fastify, "/v1/user/spot/order", ORDER_BODY, tw({ body: ORDER_BODY }));
    expect(signed.json()).toEqual({ success: 0, data: { code: 70001 } });
  });

  // nonce はクライアント側の数列で、シナリオを初期化しても戻らない（docs/plan-lab-mock.md 19.5）。
  it("直近の nonce は POST /_control/reset で捨てない", async () => {
    const { fastify } = await build();
    const path = "/v1/user/assets";
    const n = String(nextNonce++);
    const headers = nonceHeaders({ key: KEY, secret: SECRET, nonce: n, target: { path } });
    expect((await get(fastify, path, headers)).json().success).toBe(1);
    expect((await fastify.inject({ method: "POST", url: "/_control/reset" })).statusCode).toBe(200);
    expect((await get(fastify, path, headers)).json()).toEqual({
      success: 0,
      data: { code: 20001 },
    });
    expect((await get(fastify, path, nonce({ path }))).json().success).toBe(1);
  });

  it("本文が上限を超える要求は、認証の前に Fastify と同じ 413 で断る", async () => {
    const { fastify, store } = await build();
    const huge = JSON.stringify({ ...ORDER, pad: "x".repeat(1024 * 1024) });
    const res = await post(fastify, "/v1/user/spot/order", huge, tw({ body: huge }));
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: "FST_ERR_CTP_BODY_TOO_LARGE" });
    expect(store.state().orders).toEqual([]);
  });

  it("キーとシークレットを渡さなければ（null）、ヘッダ無しで通る", async () => {
    const { fastify } = await build({ apiCredentials: null });
    expect((await post(fastify, "/v1/user/spot/order", ORDER_BODY)).json().success).toBe(1);
  });

  // 省略時は環境変数を読む。テストの間は未設定（vitest.config.ts の test.env が空にしている）。
  it("省略時は環境変数を読み、未設定ならヘッダ無しで通る", async () => {
    const { fastify } = await build({ apiCredentials: undefined });
    expect((await get(fastify, "/v1/user/assets")).json().success).toBe(1);
  });
});
