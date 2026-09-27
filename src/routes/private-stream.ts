import type { FastifyPluginAsync } from "fastify";
import type { PrivateStreamHub } from "../stream/hub.ts";

/** private stream の WebSocket の口。bitbank API には無い（公式は PubNub で配信する）。 */
export const PRIVATE_STREAM_PATH = "/_stream/private";

export type PrivateStreamRouteOptions = {
  hub: PrivateStreamHub;
};

/**
 * `GET /_stream/private`（WebSocket）。接続すると、以後の状態の変化が公式と同じ形の
 * メッセージ（`{ "message": { "method", "params" } }`）で 1 フレームずつ届く。
 *
 * **PubNub を模していない。** 利用側に要るのはメッセージの中身の互換であって、PubNub の
 * プロトコルではない、という判断による（`docs/plan-lab-mock.md` 3.4、2026-09-11 に決定）。
 * `GET /v1/user/subscribe` が返すチャンネル名とトークンは、ここでは見ない。
 *
 * - **接続した時点の状態は送らない。** 公式の PubNub も購読前の変化は届けないので、利用側は
 *   接続の後に REST で取り直して突き合わせる（`docs/fidelity.md` の「private stream」）
 * - **クライアントから送られたものは読まない。** 受け付ける操作が無いので、最大長だけ絞って
 *   捨てる（`src/server/http.ts` の `STREAM_MAX_PAYLOAD`）
 * - **upgrade でない GET には 426 を返す。** `@fastify/websocket` の既定は本文の無い 404 で、
 *   「口が無い」と読めてしまうため
 */
export const privateStreamRoutes: FastifyPluginAsync<PrivateStreamRouteOptions> = async (
  fastify,
  opts,
) => {
  fastify.route({
    method: "GET",
    url: PRIVATE_STREAM_PATH,
    handler: async (_request, reply) =>
      reply.code(426).header("upgrade", "websocket").send({ error: "UPGRADE_REQUIRED" }),
    wsHandler: (socket) => {
      const remove = opts.hub.addClient({
        // 閉じかけ・閉じた後の send は `ws` が黙って捨てる（コールバックを渡さない限り投げない）。
        // その接続は `close` で購読者から外れるので、ここで状態を見て分岐する必要は無い。
        send: (text) => socket.send(text),
        close: (code, reason) => socket.close(code, reason),
      });
      socket.on("close", remove);
    },
  });
};
