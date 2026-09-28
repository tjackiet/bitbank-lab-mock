import type { FastifyInstance } from "fastify";
import { afterEach } from "vitest";
import type WebSocket from "ws";
import type { Candle } from "../../src/engine/candles.ts";
import type { PaperState } from "../../src/engine/state.ts";
import type { FetchCandles, Logger } from "../../src/engine/types.ts";
import type { AssetKeyStyle } from "../../src/routes/format.ts";
import { PRIVATE_STREAM_PATH } from "../../src/routes/private-stream.ts";
import type { FillMode } from "../../src/server/config.ts";
import { buildServer } from "../../src/server/http.ts";
import { SessionStore } from "../../src/store/session.ts";
import type { PrivateStreamMessage } from "../../src/stream/events.ts";
import { buildState } from "../engine/helpers.ts";

export function stubFetchCandles(byPair: Record<string, Candle[]>): FetchCandles {
  return async (pair, fromMs, toMs) => {
    const data = (byPair[pair] ?? []).filter((c) => c.timestamp >= fromMs && c.timestamp <= toMs);
    return { success: true, data };
  };
}

// 既定は path: null（ファイルを書かない）。永続化を見るテストだけ実パスを渡す。
export type TestServerOptions = {
  path?: string | null;
  fillMode?: FillMode;
  controlEnabled?: boolean;
  /** 既定は捨てる。ログの副作用が応答に出ないことを見るテストだけが渡す。 */
  logger?: Logger;
  /**
   * 既定は `SessionStore` の既定料率（`DEFAULT_TAKER_FEE_RATE`）。
   *
   * **率が経路の端まで通っているかを見るテストだけが渡す。** 既定のままだと、率を
   * 渡し忘れた経路と渡した経路が同じ値になり区別できない（実際 `GET /v1/user/assets` は
   * 渡し忘れていた）。
   */
  feeRate?: number;
  /**
   * 既定は `candlesByPair` を返すスタブ（`stubFetchCandles`）。**足の取得が失敗する筋を
   * 見るテストだけが渡す。** 渡さない限り外向きの口には落ちない（`SessionStore` の既定は
   * 公開 API で、`tests/network-guard.ts` がそれを落とす）。
   */
  fetchCandles?: FetchCandles;
  /** 既定は `camel`（`BITBANK_MOCK_STREAM_ASSET_KEYS` の既定）。環境変数には頼らない。 */
  streamAssetKeys?: AssetKeyStyle;
};

export async function buildTestServer(
  state: PaperState = buildState(),
  candlesByPair: Record<string, Candle[]> = {},
  opts: TestServerOptions = {},
) {
  const store = new SessionStore(state, {
    path: opts.path ?? null,
    fillMode: opts.fillMode ?? "market",
    fetchCandles: opts.fetchCandles ?? stubFetchCandles(candlesByPair),
    logger: opts.logger,
    feeRate: opts.feeRate,
  });
  const fastify = await buildServer({
    store,
    logger: false,
    controlEnabled: opts.controlEnabled ?? false,
    streamAssetKeys: opts.streamAssetKeys ?? "camel",
  });
  const close = async () => {
    await fastify.close();
  };
  return { fastify, store, close };
}

// describe ブロック内で呼ぶと、build() で作ったサーバを afterEach で自動 close する。
export function setupBuildTestServer() {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });
  return async (
    state: PaperState = buildState(),
    candlesByPair: Record<string, Candle[]> = {},
    opts: TestServerOptions = {},
  ) => {
    const r = await buildTestServer(state, candlesByPair, opts);
    cleanups.push(r.close);
    return r;
  };
}

/**
 * private stream の WebSocket が受け取ったものを溜める。
 *
 * **待ち方は `flush()` だけにする。** ping を送って pong を待つと、それより前にサーバが同じ
 * 接続へ書いたフレームは必ず先に届いている（1 本の接続の上でフレームの順序は崩れない）。
 * サーバはメッセージを状態の差し替えと同じ同期の流れで書くので、HTTP の応答を待ってから
 * `flush()` すれば、その要求が起こしたメッセージはすべて `messages` に入っている。
 * 時間で待たないので、「何も届かないこと」も確かめられる。
 */
export function streamRecorder(ws: WebSocket) {
  const messages: PrivateStreamMessage[] = [];
  ws.on("message", (data) => {
    messages.push(JSON.parse(String(data)) as PrivateStreamMessage);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  const flush = () =>
    new Promise<void>((resolve) => {
      ws.once("pong", () => resolve());
      ws.ping();
    });
  const methods = () => messages.map((m) => m.message.method);
  /** 溜めたものを取り出して空にする。 */
  const take = () => messages.splice(0);
  return { messages, closed, flush, methods, take };
}

/**
 * private stream へ繋いで、受け取ったものを溜める（`streamRecorder()`）。
 *
 * **`injectWS()` の前に `ready()` を待つ。** `injectWS()` は `upgrade` イベントを直接撃つだけで
 * サーバの起動を待たないので、起動前に呼ぶと応答が返らず固まる（`inject()` は自分で待つので、
 * 先に 1 度 `inject()` したテストだけが通ってしまい、原因が見えにくかった）。
 */
export async function connectStream(fastify: FastifyInstance) {
  await fastify.ready();
  const ws = await fastify.injectWS(PRIVATE_STREAM_PATH);
  return { ws, ...streamRecorder(ws) };
}
