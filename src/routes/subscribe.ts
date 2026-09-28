import type { FastifyPluginAsync } from "fastify";
import { ok } from "./envelope.ts";

/**
 * `GET /v1/user/subscribe` が返すチャンネル名。**ダミーで、どこでも検証しない。**
 *
 * 公式ではユーザーごとに固有のチャンネルが割り当てられ（`rest-api.md:1777`）、PubNub の
 * 購読に使う。このモックは PubNub を模さず、素の WebSocket（`/_stream/private`）で配信する
 * ので、チャンネル名もトークンも接続に要らない（`docs/fidelity.md` の「private stream」）。
 * 口座が 1 つしか無いので固定値にした。
 */
export const DUMMY_PUBNUB_CHANNEL = "bitbank-lab-mock";

/**
 * `GET /v1/user/subscribe` が返すトークン。**ダミーで、期限も検証も無い。**
 *
 * 公式のトークンは TTL 12 時間で、切れると PubNub から切断される（`rest-api.md:1778-1779`）。
 * このモックは期限切れを起こさない。呼ぶたびに同じ値を返すので、シナリオを流し直しても
 * 応答は変わらない。
 */
export const DUMMY_PUBNUB_TOKEN = "bitbank-lab-mock-dummy-token";

/**
 * `GET /v1/user/subscribe`（公式の "Get channel and token for private stream"）。
 *
 * **`store.tick()` を呼ばない唯一の互換ルートである。** 状態を 1 つも読まず、固定の値を
 * 返すだけなので、tick して約定を進める理由が無い。むしろ呼ぶと、再接続の手順
 * （subscribe → 接続）の途中、まだ繋がっていない窓で約定のイベントが流れて取りこぼされる。
 * 他の互換ルートが tick を通ることは `tests/routes/tick.test.ts` が固定しており、この経路は
 * そこの許可リストに理由つきで載っている。
 */
export const subscribeRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/v1/user/subscribe", async () =>
    ok({ pubnub_channel: DUMMY_PUBNUB_CHANNEL, pubnub_token: DUMMY_PUBNUB_TOKEN }),
  );
};
