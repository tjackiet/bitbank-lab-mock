import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PRIVATE_STREAM_PATH } from "../../src/routes/private-stream.ts";
import type { PrivateStreamMessage } from "../../src/stream/events.ts";
import type { HeldMessage } from "../../src/stream/hub.ts";
import { RESET_CLOSE_CODE, RESET_CLOSE_REASON } from "../../src/stream/hub.ts";
import { buildState } from "../engine/helpers.ts";
import { connectStream, setupBuildTestServer, streamRecorder } from "./helpers.ts";

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
