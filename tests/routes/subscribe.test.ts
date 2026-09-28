import { describe, expect, it } from "vitest";
import { DUMMY_PUBNUB_CHANNEL, DUMMY_PUBNUB_TOKEN } from "../../src/routes/subscribe.ts";
import { buildOrder, buildState, candle } from "../engine/helpers.ts";
import { setupBuildTestServer } from "./helpers.ts";
import { flatShape, OFFICIAL_SUBSCRIBE_FIELDS } from "./official-fields.ts";

describe("GET /v1/user/subscribe", () => {
  const build = setupBuildTestServer();

  it("封筒に包んだチャンネル名とトークンを、公式の応答表の形で返す", async () => {
    const { fastify } = await build();
    const res = await fastify.inject({ method: "GET", url: "/v1/user/subscribe" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(1);
    const shape = flatShape(body.data, OFFICIAL_SUBSCRIBE_FIELDS);
    expect(shape.actual).toEqual(shape.expected);
    expect(body.data).toEqual({
      pubnub_channel: DUMMY_PUBNUB_CHANNEL,
      pubnub_token: DUMMY_PUBNUB_TOKEN,
    });
  });

  it("何度呼んでも同じ値を返す（期限切れを起こさない）", async () => {
    const { fastify } = await build();
    const a = await fastify.inject({ method: "GET", url: "/v1/user/subscribe" });
    const b = await fastify.inject({ method: "GET", url: "/v1/user/subscribe" });
    expect(b.json()).toEqual(a.json());
  });

  it("market モードでも約定を進めない（状態を読まないので tick を通らない）", async () => {
    const nowMs = Date.now();
    const from = new Date(nowMs - 60_000).toISOString();
    const state = buildState({
      lastTickAt: from,
      orders: [buildOrder({ price: 5_000_000, orderedAt: from, updatedAt: from })],
    });
    const candles = {
      btc_jpy: [candle(nowMs - 30_000, 5_000_000, 5_000_000, 4_900_000, 4_950_000)],
    };
    const { fastify, store } = await build(state, candles, { fillMode: "market" });
    await fastify.inject({ method: "GET", url: "/v1/user/subscribe" });
    expect(store.state().orders[0]?.status).toBe("UNFILLED");
    // 対照: 状態を読む互換ルートなら同じ状態から約定が進む。
    await fastify.inject({ method: "GET", url: "/v1/user/assets" });
    expect(store.state().orders[0]?.status).toBe("FULLY_FILLED");
  });
});
