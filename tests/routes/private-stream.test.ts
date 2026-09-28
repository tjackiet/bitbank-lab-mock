import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PRIVATE_STREAM_PATH } from "../../src/routes/private-stream.ts";
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
