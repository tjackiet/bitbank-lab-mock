import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PRIVATE_STREAM_PATH, STREAM_REFUSED_BODY } from "../../src/routes/private-stream.ts";
import type { PrivateStreamMessage } from "../../src/stream/events.ts";
import type { HeldMessage } from "../../src/stream/hub.ts";
import {
  DISCONNECT_CLOSE_CODE,
  DISCONNECT_CLOSE_REASON,
  RESET_CLOSE_CODE,
  RESET_CLOSE_REASON,
} from "../../src/stream/hub.ts";
import { buildState } from "../engine/helpers.ts";
import { connectStream, setupBuildTestServer, streamRecorder } from "./helpers.ts";
import { OFFICIAL_STREAM_ORDER_STATUSES } from "./official-fields.ts";

const LIMIT_BUY = {
  pair: "btc_jpy",
  side: "buy",
  type: "limit",
  price: 5_000_000,
  amount: 0.001,
} as const;

describe("GET /_stream/private", () => {
  const build = setupBuildTestServer();

  it("接続した後の変化だけが届く（接続した時点の状態は送らない）", async () => {
    const { fastify } = await build(buildState(), {}, { fillMode: "manual" });
    // 接続前の発注。これは届かない。
    await fastify.inject({ method: "POST", url: "/v1/user/spot/order", payload: LIMIT_BUY });

    const { ws, ...rec } = await connectStream(fastify);
    await rec.flush();
    expect(rec.messages).toEqual([]);

    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: LIMIT_BUY,
    });
    await rec.flush();
    expect(rec.methods()).toEqual(["spot_order_new", "asset_update"]);
    expect(rec.messages[0]?.message.params[0]).toMatchObject({
      order_id: res.json().data.order_id,
      status: "UNFILLED",
    });
    ws.terminate();
  });

  it("upgrade でない GET には 426 と、upgrade を促すヘッダを返す", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({ method: "GET", url: PRIVATE_STREAM_PATH });
    expect(res.statusCode).toBe(426);
    expect(res.headers.upgrade).toBe("websocket");
    expect(res.json()).toEqual({ error: "UPGRADE_REQUIRED" });
  });

  it("POST /_control/reset で 1012 で閉じる", async () => {
    const { fastify } = await build(buildState(), {}, { fillMode: "manual", controlEnabled: true });
    const { ws, ...rec } = await connectStream(fastify);
    const reset = await fastify.inject({ method: "POST", url: "/_control/reset", payload: {} });
    expect(reset.statusCode).toBe(200);
    expect(await rec.closed).toEqual({ code: RESET_CLOSE_CODE, reason: RESET_CLOSE_REASON });
    expect(rec.messages).toEqual([]);
    expect(fastify.privateStream.clientCount()).toBe(0);
  });

  /**
   * **ここだけ実際に listen したサーバで見る。** `injectWS()` の接続はメモリ上の duplex で、
   * クライアントから閉じたときにサーバ側の socket が閉じない（ws の閉じる手順が相手の
   * 切断待ちのまま残る）。本物の TCP ならすぐ閉じるので、そちらで確かめる。
   */
  it("接続が閉じたら購読者から外れる", async () => {
    const { fastify } = await build();
    const ws = await connectOverTcp(fastify);
    await expect.poll(() => fastify.privateStream.clientCount()).toBe(1);
    const rec = streamRecorder(ws);
    ws.close();
    await rec.closed;
    await expect.poll(() => fastify.privateStream.clientCount()).toBe(0);
  });

  it("クライアントから送ったものは読まず、大きすぎるフレームは 1009 で閉じる", async () => {
    const { fastify } = await build(buildState(), {}, { fillMode: "manual" });
    const { ws, ...rec } = await connectStream(fastify);
    ws.send(JSON.stringify({ subscribe: "anything" }));
    await rec.flush();
    expect(rec.messages).toEqual([]);

    ws.send("x".repeat(2048));
    expect((await rec.closed).code).toBe(1009);
  });

  it("サーバを閉じると接続も閉じ、以後の状態の変化で投げない", async () => {
    const { fastify, store } = await build(buildState(), {}, { fillMode: "manual" });
    const { ws, ...rec } = await connectStream(fastify);
    await fastify.close();
    await rec.closed;
    expect(() => store.replace(buildState({ balances: { jpy: 1 } }))).not.toThrow();
  });

  it("streamAssetKeys に snake を渡すと asset_update が snake_case で届く", async () => {
    const { fastify } = await build(
      buildState(),
      {},
      { fillMode: "manual", streamAssetKeys: "snake" },
    );
    const { ws, ...rec } = await connectStream(fastify);
    await fastify.inject({ method: "POST", url: "/v1/user/spot/order", payload: LIMIT_BUY });
    await rec.flush();
    const asset = rec.messages.find((m) => m.message.method === "asset_update");
    expect(Object.keys(asset?.message.params[0] as object).sort()).toEqual([
      "amount_precision",
      "asset",
      "free_amount",
      "locked_amount",
      "onhand_amount",
      "withdrawing_amount",
    ]);
    ws.terminate();
  });

  /**
   * 17.2 の決定 17: `REJECTED` にした注文も、状態の差から作るまま送る（特例を作らない）。
   * **公式の stream の status の列挙（6 値）に `REJECTED` は無い**ので、公式から外れる値を
   * 送っていることをここで明示しておく（`docs/fidelity.md` の「private stream の注文ペイロード」節）。
   */
  it("POST /_control/orders/:order_id/reject は REJECTED の spot_order と、拘束が外れた asset_update を送る", async () => {
    const { fastify } = await build(buildState(), {}, { fillMode: "manual", controlEnabled: true });
    const { ws, ...rec } = await connectStream(fastify);
    await fastify.inject({ method: "POST", url: "/v1/user/spot/order", payload: LIMIT_BUY });
    await rec.flush();
    const placedAsset = rec.take()[1]?.message.params[0];
    expect(placedAsset).toMatchObject({ asset: "jpy", lockedAmount: "5006.0000" });

    const res = await fastify.inject({ method: "POST", url: "/_control/orders/1/reject" });
    expect(res.statusCode).toBe(200);
    await rec.flush();
    expect(rec.methods()).toEqual(["spot_order", "asset_update"]);

    const order = rec.messages[0]?.message.params[0] as Record<string, unknown>;
    expect(order.status).toBe("REJECTED");
    expect(OFFICIAL_STREAM_ORDER_STATUSES).not.toContain(order.status);
    // 共通部分は同じ時点の GET order と一致する（REST と stream が同じ状態を見せる）。
    const { executed_at, is_just_triggered, ...rest } = order;
    expect(executed_at).toBe(0);
    expect(is_just_triggered).toBe(false);
    const fetched = await fastify.inject({
      method: "GET",
      url: "/v1/user/spot/order?pair=btc_jpy&order_id=1",
    });
    expect(rest).toEqual(fetched.json().data);

    // 残高は動かず、拘束だけが外れる。
    expect(rec.messages[1]?.message.params[0]).toMatchObject({
      asset: "jpy",
      lockedAmount: "0.0000",
      freeAmount: "10000000.0000",
      onhandAmount: "10000000.0000",
    });
    ws.terminate();
  });

  /**
   * `injectWS()` は HTTP サーバの upgrade を通らない（`upgrade` イベントを直接撃つ）。
   * 実際に listen したサーバへ `ws` のクライアントで繋ぎ、同じものが届くことを 1 本だけ見る。
   * 宛先はループバックなので外へは出ない。
   */
  it("実際に listen したサーバへ ws クライアントで繋いでも届く", async () => {
    const { fastify } = await build(buildState(), {}, { fillMode: "manual" });
    const ws = await connectOverTcp(fastify);
    const rec = streamRecorder(ws);
    await fastify.inject({ method: "POST", url: "/v1/user/spot/order", payload: LIMIT_BUY });
    await rec.flush();
    expect(rec.methods()).toEqual(["spot_order_new", "asset_update"]);
    ws.terminate();
  });
});

/**
 * 保留・再送（`/_control/stream/*`）で、公式が保証しない届き方を WebSocket 越しに再現する。
 * 利用側の「単調性」「終端の優先」「fail-closed」を踏むための 3 つの形と、利用側が止まって
 * いる間の変化を繋ぎ直した後に届ける形を見る（`docs/fidelity.md` の「private stream の保留・再送」節）。
 */
describe("GET /_stream/private と保留・再送", () => {
  const build = setupBuildTestServer();

  /** 注文の `status` と `executed_amount`。どのスナップショットが届いたかを読むのに使う。 */
  const snapshot = (m: PrivateStreamMessage | undefined) => {
    const p = m?.message.params[0] as { status: string; executed_amount: string };
    return { method: m?.message.method, status: p.status, executed_amount: p.executed_amount };
  };

  /**
   * 指値 0.002 を置いて接続し、保留してから半分ずつ 2 回約定させる。溜まるのは
   * 部分約定（`spot_order` PARTIALLY_FILLED → `spot_trade` → `asset_update` × 2）と
   * 全量約定（`spot_order` FULLY_FILLED → `spot_trade` → `asset_update` × 2）の 8 通。
   */
  async function heldPartialThenFull() {
    const { fastify } = await build(buildState(), {}, { fillMode: "manual", controlEnabled: true });
    const { ws, ...rec } = await connectStream(fastify);
    await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { ...LIMIT_BUY, amount: 0.002 },
    });
    await rec.flush();
    rec.take();

    await fastify.inject({ method: "POST", url: "/_control/stream/hold" });
    await fastify.inject({
      method: "POST",
      url: "/_control/orders/1/fill",
      payload: { amount: 0.001 },
    });
    await fastify.inject({ method: "POST", url: "/_control/orders/1/fill" });
    await rec.flush();
    expect(rec.messages).toEqual([]);

    const held = (await fastify.inject({ method: "GET", url: "/_control/stream/held" })).json()
      .messages as HeldMessage[];
    expect(held.map((m) => m.frame.message.method)).toEqual([
      "spot_order",
      "spot_trade",
      "asset_update",
      "asset_update",
      "spot_order",
      "spot_trade",
      "asset_update",
      "asset_update",
    ]);
    const seqOf = (method: string, status?: string) => {
      const found = held.find(
        (m) =>
          m.frame.message.method === method &&
          (status === undefined ||
            (m.frame.message.params[0] as { status: string }).status === status),
      );
      if (!found) throw new Error(`${method} ${status ?? ""} が溜まっていない`);
      return found.seq;
    };
    const release = (order?: number[]) =>
      fastify.inject({
        method: "POST",
        url: "/_control/stream/release",
        payload: order === undefined ? {} : { order },
      });
    return { fastify, ws, rec, held, seqOf, release };
  }

  it("FULLY_FILLED の spot_order の後に、それより前の PARTIALLY_FILLED の spot_order が届く", async () => {
    const { ws, rec, seqOf, release } = await heldPartialThenFull();
    const partial = seqOf("spot_order", "PARTIALLY_FILLED");
    const full = seqOf("spot_order", "FULLY_FILLED");

    const res = await release([full, partial]);
    expect(res.statusCode).toBe(200);
    await rec.flush();
    expect(rec.messages.map(snapshot)).toEqual([
      { method: "spot_order", status: "FULLY_FILLED", executed_amount: "0.0020" },
      { method: "spot_order", status: "PARTIALLY_FILLED", executed_amount: "0.0010" },
    ]);
    ws.terminate();
  });

  it("同じ spot_order が 2 通届く", async () => {
    const { ws, rec, held, seqOf, release } = await heldPartialThenFull();
    const full = seqOf("spot_order", "FULLY_FILLED");
    const all = held.map((m) => m.seq);

    // 溜めた順にすべて送り、FULLY_FILLED の spot_order だけもう 1 度送る。
    const res = await release([...all, full]);
    expect(res.json()).toEqual({ sent: all.length + 1, omitted: [], clients: 1 });
    await rec.flush();
    const orders = rec.messages.filter((m) => m.message.method === "spot_order");
    expect(orders.map(snapshot)).toEqual([
      { method: "spot_order", status: "PARTIALLY_FILLED", executed_amount: "0.0010" },
      { method: "spot_order", status: "FULLY_FILLED", executed_amount: "0.0020" },
      { method: "spot_order", status: "FULLY_FILLED", executed_amount: "0.0020" },
    ]);
    // 2 通は同じフレームそのもの（作り直していない）。
    expect(orders[2]).toEqual(orders[1]);
    ws.terminate();
  });

  it("spot_trade が欠ける", async () => {
    const { ws, rec, held, seqOf, release } = await heldPartialThenFull();
    const firstTrade = seqOf("spot_trade");
    const order = held.map((m) => m.seq).filter((seq) => seq !== firstTrade);

    const res = await release(order);
    expect(res.json()).toEqual({ sent: held.length - 1, omitted: [firstTrade], clients: 1 });
    await rec.flush();
    // 届いた約定は 2 回目（全量約定）の 1 通だけ。注文と資産の通知は欠けずに届く。
    const secondTrade = held.find(
      (m) => m.frame.message.method === "spot_trade" && m.seq !== firstTrade,
    );
    const trades = rec.messages.filter((m) => m.message.method === "spot_trade");
    expect(trades).toEqual([secondTrade?.frame]);
    expect(rec.messages).toEqual(held.filter((m) => m.seq !== firstTrade).map((m) => m.frame));
    ws.terminate();
  });

  it("release の後は通常の配信に戻る", async () => {
    const { fastify, ws, rec, release } = await heldPartialThenFull();
    await release();
    await rec.flush();
    rec.take();
    await fastify.inject({ method: "POST", url: "/v1/user/spot/order", payload: LIMIT_BUY });
    await rec.flush();
    expect(rec.methods()).toEqual(["spot_order_new", "asset_update"]);
    ws.terminate();
  });

  it("保留中の reject は他の変化と同じく溜まり、release で届く", async () => {
    const { fastify } = await build(buildState(), {}, { fillMode: "manual", controlEnabled: true });
    const { ws, ...rec } = await connectStream(fastify);
    await fastify.inject({ method: "POST", url: "/v1/user/spot/order", payload: LIMIT_BUY });
    await rec.flush();
    rec.take();

    await fastify.inject({ method: "POST", url: "/_control/stream/hold" });
    const rejected = await fastify.inject({ method: "POST", url: "/_control/orders/1/reject" });
    expect(rejected.statusCode).toBe(200);
    await rec.flush();
    expect(rec.messages).toEqual([]);

    const held = (await fastify.inject({ method: "GET", url: "/_control/stream/held" })).json()
      .messages as HeldMessage[];
    expect(held.map((m) => m.frame.message.method)).toEqual(["spot_order", "asset_update"]);
    expect(held[0]?.frame.message.params[0]).toMatchObject({ status: "REJECTED" });

    const res = await fastify.inject({ method: "POST", url: "/_control/stream/release" });
    expect(res.json()).toEqual({ sent: 2, omitted: [], clients: 1 });
    await rec.flush();
    expect(rec.messages).toEqual(held.map((m) => m.frame));
    ws.terminate();
  });

  it("保留の後に繋いだ接続にも、繋ぐ前の変化が release で届く（利用側が止まっている間の変化）", async () => {
    const { fastify } = await build(buildState(), {}, { fillMode: "manual", controlEnabled: true });
    await fastify.inject({ method: "POST", url: "/_control/stream/hold" });
    // 誰も繋いでいない間の発注。保留中なので溜まる。
    const placed = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: LIMIT_BUY,
    });

    // 繋ぐ前の release は断られ、溜めたものは残る（誰にも届かずに消えない）。
    const early = await fastify.inject({ method: "POST", url: "/_control/stream/release" });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toEqual({ error: "NO_STREAM_CLIENTS", held: 2 });

    const { ws, ...rec } = await connectStream(fastify);
    await rec.flush();
    expect(rec.messages).toEqual([]);
    const res = await fastify.inject({ method: "POST", url: "/_control/stream/release" });
    expect(res.json()).toEqual({ sent: 2, omitted: [], clients: 1 });
    await rec.flush();
    expect(rec.methods()).toEqual(["spot_order_new", "asset_update"]);
    expect(rec.messages[0]?.message.params[0]).toMatchObject({
      order_id: placed.json().data.order_id,
      status: "UNFILLED",
    });
    ws.terminate();
  });
});

/**
 * 切断（`/_control/stream/disconnect`）と、新しい接続を受け付けない状態（`/_control/stream/refuse`・
 * `/_control/stream/accept`）を WebSocket 越しに見る。利用側の「fail-closed」と「再同期」を、
 * stream が**切れる**形で踏むための口（`docs/fidelity.md` の「private stream の切断」節）。
 */
describe("GET /_stream/private と切断", () => {
  const build = setupBuildTestServer();

  async function setup() {
    const { fastify } = await build(buildState(), {}, { fillMode: "manual", controlEnabled: true });
    const post = (url: string, payload?: Record<string, unknown>) =>
      fastify.inject({ method: "POST", url, ...(payload === undefined ? {} : { payload }) });
    const orderOf = async (orderId: number) =>
      (await post("/v1/user/spot/orders_info", { pair: "btc_jpy", order_ids: [orderId] })).json()
        .data.orders[0];
    const accepting = async () =>
      (await fastify.inject({ method: "GET", url: "/_control/stream/held" })).json().accepting;
    return { fastify, post, orderOf, accepting };
  }

  it("disconnect で 1001 と reason が届き、注文は REST の照合で見えたまま残る", async () => {
    const { fastify, post, orderOf } = await setup();
    const { ws, ...rec } = await connectStream(fastify);
    const placed = await post("/v1/user/spot/order", LIMIT_BUY);
    const orderId = placed.json().data.order_id as number;
    await rec.flush();
    rec.take();

    const res = await post("/_control/stream/disconnect");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ closed: 1 });
    expect(await rec.closed).toEqual({
      code: DISCONNECT_CLOSE_CODE,
      reason: DISCONNECT_CLOSE_REASON,
    });
    expect(rec.messages).toEqual([]);
    expect(fastify.privateStream.clientCount()).toBe(0);

    // reset と違って状態は残る（注文 id も配り直さない）。
    expect(await orderOf(orderId)).toMatchObject({ order_id: orderId, status: "UNFILLED" });
    // 接続が 0 本でも成功にする（失うものが無い）。
    const again = await post("/_control/stream/disconnect");
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ closed: 0 });
    ws.terminate();
  });

  it("hold → disconnect → 変化 → 繋ぎ直す → release で、切っていた間の変化が届く", async () => {
    const { fastify, post, orderOf } = await setup();
    const first = await connectStream(fastify);
    await post("/v1/user/spot/order", LIMIT_BUY);
    await first.flush();
    first.take();

    await post("/_control/stream/hold");
    await post("/_control/stream/disconnect");
    expect((await first.closed).code).toBe(DISCONNECT_CLOSE_CODE);
    // 切っている間の全量約定。接続は 0 本だが、保留中なので溜まる。
    expect((await post("/_control/orders/1/fill")).statusCode).toBe(200);
    // 繋ぐ前の release は断られ、溜めたものは残る。
    expect((await post("/_control/stream/release")).statusCode).toBe(409);

    const { ws, ...rec } = await connectStream(fastify);
    await rec.flush();
    expect(rec.messages).toEqual([]);
    const res = await post("/_control/stream/release");
    expect(res.json()).toEqual({ sent: 4, omitted: [], clients: 1 });
    await rec.flush();
    expect(rec.methods()).toEqual(["spot_order", "spot_trade", "asset_update", "asset_update"]);
    const streamed = rec.messages[0]?.message.params[0] as Record<string, unknown>;
    expect(streamed).toMatchObject({ order_id: 1, status: "FULLY_FILLED" });
    // 届いた注文は同じ時点の REST の照合と一致する。
    const { executed_at, is_just_triggered, ...rest } = streamed;
    expect(rest).toEqual(await orderOf(1));
    expect(first.messages).toEqual([]);
    ws.terminate();
  });

  it("refuse の間は upgrade を 503 で断り、accept の後は繋がる", async () => {
    const { fastify, post, accepting } = await setup();
    const refuse = await post("/_control/stream/refuse");
    expect(refuse.statusCode).toBe(200);
    expect(refuse.json()).toEqual({ accepting: false });
    expect(await accepting()).toBe(false);

    await fastify.ready();
    await expect(fastify.injectWS(PRIVATE_STREAM_PATH)).rejects.toThrow(
      "Unexpected server response: 503",
    );
    expect(fastify.privateStream.clientCount()).toBe(0);
    // upgrade でない GET も 503（426 より先に判定する）。本文は素の JSON。
    const plain = await fastify.inject({ method: "GET", url: PRIVATE_STREAM_PATH });
    expect(plain.statusCode).toBe(503);
    expect(plain.json()).toEqual(STREAM_REFUSED_BODY);
    expect(STREAM_REFUSED_BODY).toEqual({ error: "STREAM_REFUSED" });

    const accept = await post("/_control/stream/accept");
    expect(accept.json()).toEqual({ accepting: true });
    expect(await accepting()).toBe(true);
    const { ws, ...rec } = await connectStream(fastify);
    await post("/v1/user/spot/order", LIMIT_BUY);
    await rec.flush();
    expect(rec.methods()).toEqual(["spot_order_new", "asset_update"]);
    // 受け付ける状態に戻ったので、upgrade でない GET は 426 に戻る。
    const upgradeRequired = await fastify.inject({ method: "GET", url: PRIVATE_STREAM_PATH });
    expect(upgradeRequired.statusCode).toBe(426);
    ws.terminate();
  });

  it("refuse → disconnect の順なら切ったまま繋がらず、その間も REST の照合と発注は通る", async () => {
    const { fastify, post, orderOf } = await setup();
    const first = await connectStream(fastify);
    await post("/_control/stream/refuse");
    // refuse は今の接続を閉じない。
    await post("/v1/user/spot/order", LIMIT_BUY);
    await first.flush();
    expect(first.methods()).toEqual(["spot_order_new", "asset_update"]);

    expect((await post("/_control/stream/disconnect")).json()).toEqual({ closed: 1 });
    expect((await first.closed).code).toBe(DISCONNECT_CLOSE_CODE);
    // 利用側がすぐ繋ぎ直そうとしても断られる。
    await expect(fastify.injectWS(PRIVATE_STREAM_PATH)).rejects.toThrow(
      "Unexpected server response: 503",
    );

    // 切れている間の発注。保留していないので、stream には誰にも届かない。
    const placed = await post("/v1/user/spot/order", LIMIT_BUY);
    expect(placed.json().success).toBe(1);
    const orderId = placed.json().data.order_id as number;
    expect(await orderOf(orderId)).toMatchObject({ order_id: orderId, status: "UNFILLED" });

    await post("/_control/stream/accept");
    const { ws, ...rec } = await connectStream(fastify);
    await rec.flush();
    // 切れていた間の変化は届かない。拾うのは REST の照合（再同期）。
    expect(rec.messages).toEqual([]);
    ws.terminate();
  });

  it("refuse の後に reset すると、受け付ける状態に戻る", async () => {
    const { fastify, post, accepting } = await setup();
    await post("/_control/stream/refuse");
    expect((await post("/_control/reset", {})).statusCode).toBe(200);
    expect(await accepting()).toBe(true);
    const { ws, ...rec } = await connectStream(fastify);
    await post("/v1/user/spot/order", LIMIT_BUY);
    await rec.flush();
    expect(rec.methods()).toEqual(["spot_order_new", "asset_update"]);
    ws.terminate();
  });

  /** `injectWS()` は応答の本文を読めないので、本物の upgrade の要求で 503 の本文まで見る。 */
  it("実際に listen したサーバへの upgrade も、HTTP 503 と素の JSON で断る", async () => {
    const { fastify, post } = await setup();
    await post("/_control/stream/refuse");
    await fastify.listen({ port: 0, host: "127.0.0.1" });
    const address = fastify.server.address();
    if (address === null || typeof address === "string") throw new Error("listen していない");
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}${PRIVATE_STREAM_PATH}`);
    const refused = await new Promise<{ status?: number; type?: string; body: string }>(
      (resolve, reject) => {
        ws.once("open", () => reject(new Error("繋がってしまった")));
        ws.once("unexpected-response", (_req, res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () =>
            resolve({ status: res.statusCode, type: res.headers["content-type"], body }),
          );
        });
      },
    );
    expect(refused.status).toBe(503);
    expect(refused.type).toMatch(/^application\/json/);
    expect(JSON.parse(refused.body)).toEqual(STREAM_REFUSED_BODY);
    expect(fastify.privateStream.clientCount()).toBe(0);
  });
});

/** ループバックの空きポートで listen させ、`ws` のクライアントで繋ぐ。 */
async function connectOverTcp(fastify: FastifyInstance): Promise<WebSocket> {
  await fastify.listen({ port: 0, host: "127.0.0.1" });
  const address = fastify.server.address();
  if (address === null || typeof address === "string") throw new Error("listen していない");
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}${PRIVATE_STREAM_PATH}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}
