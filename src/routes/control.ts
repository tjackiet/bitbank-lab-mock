import { timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { type Candle, isValidCandle, isValidCandleTimestamp } from "../engine/candles.ts";
import { runTick } from "../engine/match.ts";
import { fitsDigits, precisionOf } from "../engine/precision.ts";
import { freshState, isActive, latestRecordMs, pairAssets, remainingOf } from "../engine/state.ts";
import { fillOrder, rejectOrder } from "../engine/transitions.ts";
import type { FaultInjector } from "../server/faults.ts";
import { formatOrder, formatTrade } from "./format.ts";
import { asRecord } from "./params.ts";

export type ControlRouteOptions = {
  token?: string;
  /** REST の障害注入（`/faults`）の持ち主。`buildServer()` が互換ルートにフックを掛けたものを渡す。 */
  faults: FaultInjector;
};

/** `DELETE /_control/faults/:id` の id。10 進の正の整数でなければ `null`（該当なしとして 404）。 */
function faultId(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  const normalized = ip.replace(/^::ffff:/i, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

/**
 * 接続元のアドレス。TCP の対向アドレスだけを見る。
 *
 * **この判定を `request.ip` に戻してはいけない。** `request.ip` は Fastify の `trustProxy` を
 * 有効にすると `X-Forwarded-For` の値を返すので、そちらを使うと、ヘッダに `127.0.0.1` を
 * 書いた非ループバックの要求がトークン無しでこの境界を通る（`trustProxy` を設定するか
 * どうかはログの都合で決まる話で、control の許可判定がそれに左右されてはならない）。
 * ソケットから直接読む限り、`buildServer()` の `trustProxy` の有無で境界は変わらない。
 */
function clientIp(request: FastifyRequest): string | undefined {
  return request.socket.remoteAddress;
}

/**
 * `X-Control-Token` の値。ヘッダ行が無いときと 2 行以上あるときは `null`。
 *
 * Node は `set-cookie` 以外の同名ヘッダが複数行来ると `request.headers` 側では `", "` で
 * 繋いだ 1 本の文字列にする。繋いだ結果がたまたま設定値と一致する形（`part1, part2`）に
 * なり得るので、行数は生ヘッダで数えて、ちょうど 1 本のときだけ値を返す。
 */
export function controlTokenHeader(request: FastifyRequest): string | null {
  const raw = request.raw.rawHeaders;
  let found: string | null = null;
  let count = 0;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i].toLowerCase() !== "x-control-token") continue;
    count += 1;
    found = raw[i + 1];
  }
  return count === 1 ? found : null;
}

/**
 * `X-Control-Token` が設定値と一致するか。一致しない位置が先頭か末尾かで比較時間が
 * 変わらないよう `timingSafeEqual` で見る（長さの違いは隠せないので、トークンは
 * 固定長で運用する）。
 */
function tokenMatches(given: string, expected: string): boolean {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 残高の資産キーに許す文字種。互換ルートが作る資産名はペアのセグメント
 * （`[a-z0-9]+`、src/engine/state.ts の `pairAssets`）に限られるので、control からも
 * 同じ形しか入れない。ここを開けると、空文字・改行入り・大文字の資産名が
 * `GET /v1/user/assets` の `asset` に現れ、状態ファイルにも残る。
 */
const ASSET_KEY_RE = /^[a-z0-9]+$/;

/**
 * `/_control/` の時計（`lastTickAt`）を 1 度に動かせる幅。**基準は時計のモードで変わる。**
 *
 * **実時刻モード（既定）: 実時刻からの先行幅。** `POST /_control/tick` が `lastTickAt` を進める
 * 経路は 2 つあり、どちらもこの幅で止める。片方だけ塞いでももう片方から進むので、両方に効かせる。
 *
 * - 利用者が渡す足の `timestamp`（1 桁の打ち間違いがそのまま時計になる）
 * - tick ごとの 60 秒の単調前進（1 回ずつは小さいが、繰り返すと際限が無い）
 *
 * **仮想時計（`BITBANK_MOCK_CLOCK=virtual`）: 1 回の要求で進める幅。** 「実時刻から」の上限を外し、
 * いまの仮想時刻からこの幅までにする（`docs/plan-lab-mock.md` 17.2 の決定 27）。繰り返せば
 * 何日でも先へ進めるのは意図した操作なので止めない。打ち間違いは今と同じく 1 回の要求で断れる。
 *
 * 24 時間にしたのは、`runTick` が 1 回の tick で遡る上限（`MAX_LOOKBACK_MS`）と同じ幅で、
 * 1 分足なら 1 日分（1440 本）にあたるため。合成の tick を 1440 回重ねるまでは今までどおり
 * 通り、`4e12`（西暦 2096）のような打ち間違いはこの幅で落ちる。
 *
 * これは #20 / #21 で入れた足の `timestamp` の上限（`Date` の表現範囲 − JST オフセット、
 * `isValidCandleTimestamp`）とは別の、その内側にある制約（仮想時計でもそちらはそのまま効く）。
 * `/_control/` の中だけで持ち、互換ルート（`/v1/user/...`）の時刻には一切効かせない。
 */
const MAX_CLOCK_AHEAD_MS = 24 * 60 * 60 * 1000;

/** 足の長さ（1 分足）。約定時刻は足の `timestamp` + これ（`applyFill`）。 */
const CANDLE_MS = 60_000;

/**
 * `POST /_control/tick` が受ける足の `timestamp` の範囲と、tick の後の時計。時計のモードで変わる
 * ので、モードごとに組み立てて（`realTickBounds()` / `virtualTickBounds()`）ハンドラは 1 本にする。
 */
type TickBounds = {
  /** 足の `timestamp` を省いたとき（`{ price }` の合成の足を含む）に使う値。 */
  defaultTimestamp: number;
  /** 受ける `timestamp` の下限（含む）。下限が無ければ `null`。 */
  minTimestamp: number | null;
  /** 受ける `timestamp` の上限（含む）。 */
  maxTimestamp: number;
  /** tick の後の時計（`runTick` の `nowMs`）を、足の `timestamp` から決める。 */
  clockAfter: (timestamp: number) => number;
};

/**
 * 実時刻モードの tick の範囲。**仮想時計を足す前の挙動のまま**で、仮想時計のために変えていない。
 *
 * 1 分足が同じ実時刻の 2 本でも別の窓に落ちるよう、tick ごとに最低 60 秒進める
 * （`max(realNowMs, lastTickAt + 60 秒)`）。その 60 秒だけで上限を越えるなら（＝時計が上限の
 * 60 秒手前まで来ているなら）、進めずに断る（`null`）。ここで黙ってクランプすると 60 秒の前進が
 * 崩れて、同じ実時刻の 2 本が同じ窓・同じ約定時刻に落ちる。断られた側は `POST /_control/clock` で
 * 時計だけ戻せる（注文・約定・残高は残る）。
 *
 * 過去の足はそのまま通す（過去の足を流し直す用途）。止めるのは先の側だけ。約定時刻は
 * `timestamp + 1 分` なので、**時計（`max(前進の下限, timestamp)`）より最大 1 分先に記録される**
 * （`docs/fidelity.md` の「control の時計」節）。
 */
function realTickBounds(lastMs: number, realNowMs: number): TickBounds | null {
  const maxMs = realNowMs + MAX_CLOCK_AHEAD_MS;
  const nowMs = Math.max(realNowMs, lastMs + CANDLE_MS);
  if (nowMs > maxMs) return null;
  return {
    defaultTimestamp: nowMs,
    minTimestamp: null,
    maxTimestamp: maxMs,
    clockAfter: (timestamp) => Math.max(nowMs, timestamp),
  };
}

/**
 * 仮想時計の tick の範囲。**「いまの時刻から始まる 1 分足が閉じて、その終わりに約定し、時計も
 * そこへ進む」**形にする（`docs/fidelity.md` の「仮想時計」節）。
 *
 * - 足の既定の `timestamp` はいまの仮想時刻。いまの時刻に出した注文（`ordered_at` が同じ値）にも
 *   当たる（`runTick` は `orderedAt <= timestamp` の注文を見る）
 * - tick の後の時計は `timestamp + 1 分`（`max(いまの時刻, timestamp + 1 分)` と同じ。下限が
 *   いまの時刻なので）。約定時刻（`applyFill` の `timestamp + 1 分`）と一致するので、
 *   **約定が時計より先に残らない**。実時刻モードと同じく 1 回で必ず 60 秒以上進む
 * - いまの時刻より前の足は断る。約定時刻が既存の記録より前になり得るため
 *   （`POST /_control/clock` の巻き戻しの下限と揃える。17.2 の決定 28）
 * - 上限は tick の後の時計がいまの時刻 + 24 時間を越えないところ（決定 27）
 */
function virtualTickBounds(virtualNowMs: number): TickBounds {
  return {
    defaultTimestamp: virtualNowMs,
    minTimestamp: virtualNowMs,
    maxTimestamp: virtualNowMs + MAX_CLOCK_AHEAD_MS - CANDLE_MS,
    clockAfter: (timestamp) => timestamp + CANDLE_MS,
  };
}

function syntheticCandle(price: number, timestamp: number): Candle {
  return { open: price, high: price, low: price, close: price, vol: 0, timestamp };
}

/**
 * `POST /_control/stream/release` の本文から `order` を取り出す。本文の省略・`{}`・`order` の
 * 省略は `undefined`（溜めた順にすべて送る）。形が違えば `null`（400 で断る）。
 *
 * ここで見るのは**形だけ**（オブジェクトで、`order` が数値の配列）。整数か・溜めた番号の範囲に
 * 収まるか・長すぎないかは溜めた数を知っている hub が見る（`PrivateStreamHub.release()`）。
 * 文字列の `"1"` は数へ強制しない——番号を打ち間違えたまま別のメッセージを送らないため。
 */
function releaseOrder(body: unknown): number[] | undefined | null {
  if (body === undefined) return undefined;
  const record = asRecord(body);
  if (!record) return null;
  const order = record.order;
  if (order === undefined) return undefined;
  if (!Array.isArray(order) || !order.every((x) => typeof x === "number")) return null;
  return order;
}

/**
 * `/_control/` の実験用ルート群。bitbank API には存在しないので、応答は bitbank 封筒に
 * 包まず素の JSON で返し、失敗は HTTP ステータス（400 / 403 / 404 / 409。状態ファイルへの
 * 書き出しに失敗した後は状態を変える口が 503）で表す。
 * 登録は `BITBANK_MOCK_CONTROL=1` のときだけ（src/server/http.ts の `buildServer()`）。
 */
export const controlRoutes: FastifyPluginAsync<ControlRouteOptions> = async (fastify, opts) => {
  /**
   * 許可判定。ループバックからは無条件に通し、それ以外は `X-Control-Token` が
   * `opts.token` と一致するときだけ通す。トークン未設定なら非ループバックは常に 403。
   */
  fastify.addHook("onRequest", async (request, reply) => {
    if (isLoopback(clientIp(request))) return;
    const expected = opts.token;
    const given = controlTokenHeader(request);
    if (!expected || given === null || !tokenMatches(given, expected)) {
      return reply.code(403).send({ error: "FORBIDDEN" });
    }
  });

  /**
   * `PaperState` に、状態ファイルへの書き出しの状況（`persist`）と足の取得の状況
   * （`candles`）を添えて返す（デバッグ用）。
   *
   * `persist` と `candles` はどちらも `PaperState` の一部ではない。`PaperStateSchema` は
   * 不明なキーを落とすので、この応答をそのまま状態ファイルへ書き戻しても読み込みは通る。
   *
   * `candles` を並べるのは、**市場モードで足の取得に失敗しても互換ルートが成功応答を
   * 返し続ける**ためである（失敗した窓は取り直さず、`lastTickAt` はそのまま進む）。
   * 約定が起きないという結果だけからは「価格が届いていない」と「足が取れていない」を
   * 区別できないので、区別する手段をここに置く（`docs/fidelity.md` の
   * 「足の取得の健全性」）。
   *
   * メッセージは JSON の値として載せるだけで、ログのように包み直しはしない。応答自体が
   * JSON なので、シリアライザが改行も制御文字も逃がす（ログで包むのは、行指向の出力では
   * 改行が行を割るからで、`persist.lastError.message` も同じ扱い）。
   *
   * 仮想時計（`BITBANK_MOCK_CLOCK=virtual`）のときは `clock: { mode: "virtual" }` も添える。
   * 仮想時計が効いているかを応答だけで確かめるため（`candles.fillMode` と同じ考え方）。
   * いまの仮想時刻は `lastTickAt` そのもの。
   */
  fastify.get("/state", async () => ({
    ...fastify.store.state(),
    persist: fastify.store.persistHealth(),
    candles: fastify.store.candlesHealth(),
    // 仮想時計のときだけ添える。実時刻モード（既定）の応答の形は変えない（無いことが実時刻の印）。
    ...(fastify.store.clockMode === "virtual" ? { clock: { mode: "virtual" } } : {}),
  }));

  /**
   * 状態を初期化する。`initialJpy` は非負の有限数、`balances` は資産キーが
   * `[a-z0-9]+` で値が非負の有限数のときだけ受け、外れたら 400 `INVALID_BALANCES` を
   * 返して状態は変えない。検査を通ったときだけ差し替えて状態ファイルへ書く。
   */
  fastify.post("/reset", async (request, reply) => {
    const body = asRecord(request.body) ?? {};
    const current = fastify.store.state();
    let initialJpy = current.initialJpy;
    if (body.initialJpy !== undefined) {
      if (
        typeof body.initialJpy !== "number" ||
        !Number.isFinite(body.initialJpy) ||
        body.initialJpy < 0
      ) {
        return reply.code(400).send({ error: "INVALID_BALANCES" });
      }
      initialJpy = body.initialJpy;
    }
    let next = freshState(initialJpy);
    if (body.balances !== undefined) {
      if (
        body.balances === null ||
        typeof body.balances !== "object" ||
        Array.isArray(body.balances)
      ) {
        return reply.code(400).send({ error: "INVALID_BALANCES" });
      }
      const balances: Record<string, number> = {};
      for (const [asset, amount] of Object.entries(body.balances as Record<string, unknown>)) {
        if (!ASSET_KEY_RE.test(asset)) {
          return reply.code(400).send({ error: "INVALID_BALANCES" });
        }
        if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
          return reply.code(400).send({ error: "INVALID_BALANCES" });
        }
        balances[asset] = amount;
      }
      next = { ...next, balances };
    }
    // commit() ではなく reset() を通す。購読者（private stream）に「差分ではなく丸ごとの
    // 差し替え」だと伝えるため（`docs/fidelity.md` の「private stream と状態の初期化」）。
    await fastify.store.reset(next);
    return next;
  });

  fastify.post("/tick", async (request, reply) => {
    const body = asRecord(request.body);
    // 互換ルート（POST /v1/user/spot/order）と同じ pairAssets で弾く。ここは外向きに
    // 出ない口だが、状態ファイル由来の文字種が不正なペアを runTick へ渡すと、
    // fillOrder が INVALID_PAIR を返して runTick ごと失敗する。先に落とせば、利用者は
    // `applyFill: INVALID_PAIR` ではなく `INVALID_PAIR` を受け取れる。
    if (!body || typeof body.pair !== "string" || !pairAssets(body.pair)) {
      return reply.code(400).send({ error: "INVALID_PAIR" });
    }
    const store = fastify.store;
    let bounds: TickBounds;
    if (store.clockMode === "virtual") {
      bounds = virtualTickBounds(store.now());
    } else {
      // ここは `store.now()` ではなく実時刻を読む。実時刻モードの上限は「実時刻から 24 時間」と
      // 決めてあり（`MAX_CLOCK_AHEAD_MS`）、記録する時刻の出どころ（`store.now()`）とは別の基準
      // だから。`src/routes/` で `Date.now()` を直に呼んでよいのは、ここと `POST /clock` の
      // 2 か所だけ（`tests/routes/time-source.test.ts`）。
      const realNowMs = Date.now();
      const real = realTickBounds(Date.parse(store.state().lastTickAt), realNowMs);
      if (real === null) {
        return reply.code(400).send({
          error: "CLOCK_TOO_FAR_AHEAD",
          lastTickAt: store.state().lastTickAt,
          maxLastTickAt: new Date(realNowMs + MAX_CLOCK_AHEAD_MS).toISOString(),
        });
      }
      bounds = real;
    }
    let candle: Candle;
    if (body.candle !== undefined) {
      const raw = asRecord(body.candle);
      if (!raw) return reply.code(400).send({ error: "INVALID_CANDLE" });
      candle = {
        open: Number(raw.open),
        high: Number(raw.high),
        low: Number(raw.low),
        close: Number(raw.close),
        vol: Number(raw.vol ?? 0),
        timestamp: raw.timestamp === undefined ? bounds.defaultTimestamp : Number(raw.timestamp),
      };
    } else if (body.price !== undefined) {
      const price = Number(body.price);
      candle = syntheticCandle(price, bounds.defaultTimestamp);
    } else {
      return reply.code(400).send({ error: "INVALID_CANDLE" });
    }
    if (!isValidCandle(candle)) return reply.code(400).send({ error: "INVALID_CANDLE" });
    // 範囲の外はクランプせず断る。足の timestamp を黙って書き換えると約定時刻
    // （applyFill の candle.timestamp + 1 分）が渡した値とずれるため。断れば状態は
    // 変わらないので、打ち間違えても組み立てたシナリオは残る。
    if (bounds.minTimestamp !== null && candle.timestamp < bounds.minTimestamp) {
      return reply
        .code(400)
        .send({ error: "CANDLE_BEFORE_CLOCK", minTimestamp: bounds.minTimestamp });
    }
    if (candle.timestamp > bounds.maxTimestamp) {
      return reply
        .code(400)
        .send({ error: "CANDLE_TOO_FAR_AHEAD", maxTimestamp: bounds.maxTimestamp });
    }

    const r = runTick(store.state(), {
      candles: [candle],
      nowMs: bounds.clockAfter(candle.timestamp),
      pair: body.pair,
      feeRate: store.feeRate,
    });
    if (!r.success) return reply.code(400).send({ error: r.error });
    await store.commit(r.data.state);
    return { filled: r.data.filled.map(formatTrade), lastTickAt: r.data.lastTickAt };
  });

  /**
   * 時計（`lastTickAt`）だけを動かす。`POST /_control/reset` と違って注文・約定・残高は
   * そのまま残すので、`MAX_CLOCK_AHEAD_MS` に当たった tick や、先へ行き過ぎた時計の
   * 後始末を、組み立てたシナリオを捨てずに行える。仮想時計では、これが時計を進める口になる。
   *
   * 本文は次のどれか。外れたら 400 で状態は変えない。
   *
   * - 省略か `{}`: 現在時刻へ戻す。**仮想時計では断る**（400 `CLOCK_TARGET_REQUIRED`）——
   *   「現在時刻」に意味が無く、黙って実時刻へ飛ぶと以後の記録が実時刻になるため
   * - `{ lastTickAt }`: その時刻へ動かす。ISO 文字列かエポックミリ秒で、足の `timestamp` と
   *   同じ範囲（`isValidCandleTimestamp`）
   * - `{ advanceMs }`: いまの `lastTickAt` から N ミリ秒進める。正の整数で、進めた先は上と
   *   同じ範囲。**1 回で進める幅は `MAX_CLOCK_AHEAD_MS` まで**（どちらのモードでも）
   *
   * 両方を渡したら 400 `INVALID_CLOCK`（どちらを採るか決められない）。
   *
   * 上限（400 `CLOCK_TOO_FAR_AHEAD`）と下限は時計のモードで変わる。
   *
   * - 実時刻モード: 上限は現在時刻 + `MAX_CLOCK_AHEAD_MS`（`advanceMs` ではさらに
   *   いまの `lastTickAt` + `MAX_CLOCK_AHEAD_MS`）。下限は無く、戻す向きにも使える
   *   （過去の足を流し直す前に時計を戻す用途がある）
   * - 仮想時計: 上限はいまの仮想時刻 + `MAX_CLOCK_AHEAD_MS`（17.2 の決定 27）。**既存の記録
   *   （`latestRecordMs()`）より前へは置けない**（400 `CLOCK_BEFORE_RECORDS`。決定 28）。
   *   記録より後であれば戻せる。記録より前へ戻したいときは reset する
   *
   * `updatedAt` はどちらのモードでも実時刻で更新する。時計を戻しても「状態を最後に変えた時刻」は
   * 戻らない。
   */
  fastify.post("/clock", async (request, reply) => {
    // 本文を省略したときだけ `{}`（＝現在時刻へ戻す）と見なす。`asRecord()` は配列・
    // null・数値・文字列でも null を返すので、`?? {}` にすると `[]` のような壊れた本文が
    // 「本文なし」と同じ扱いになり、黙って時計が動いてしまう。
    const body = request.body === undefined ? {} : asRecord(request.body);
    if (!body) return reply.code(400).send({ error: "INVALID_CLOCK" });
    if (body.lastTickAt !== undefined && body.advanceMs !== undefined) {
      return reply.code(400).send({ error: "INVALID_CLOCK" });
    }
    const store = fastify.store;
    const virtual = store.clockMode === "virtual";
    // ここは `store.now()` ではなく実時刻を読む。理由は `POST /tick` の `realNowMs` と同じで、
    // 実時刻モードの上限（`MAX_CLOCK_AHEAD_MS`）は「実時刻から 24 時間」と決めてあるため。
    // 本文を省いたときの行き先と、`updatedAt`（両モード）にも使う。
    const realNowMs = Date.now();
    const previousLastTickAt = store.state().lastTickAt;
    const lastMs = Date.parse(previousLastTickAt);
    let ms: number;
    // 上限。本文を省いたとき（実時刻モードで現在時刻へ戻す）は見ない。
    let maxMs: number | null = null;
    if (body.advanceMs !== undefined) {
      const advanceMs = body.advanceMs;
      if (typeof advanceMs !== "number" || !Number.isSafeInteger(advanceMs) || advanceMs <= 0) {
        return reply.code(400).send({ error: "INVALID_CLOCK" });
      }
      ms = lastMs + advanceMs;
      maxMs = (virtual ? lastMs : Math.min(realNowMs, lastMs)) + MAX_CLOCK_AHEAD_MS;
    } else if (body.lastTickAt !== undefined) {
      const raw = body.lastTickAt;
      if (typeof raw === "number") ms = raw;
      else if (typeof raw === "string") ms = Date.parse(raw);
      else return reply.code(400).send({ error: "INVALID_CLOCK" });
      maxMs = (virtual ? lastMs : realNowMs) + MAX_CLOCK_AHEAD_MS;
    } else {
      if (virtual) return reply.code(400).send({ error: "CLOCK_TARGET_REQUIRED" });
      ms = realNowMs;
    }
    if (maxMs !== null) {
      // Date.parse は解釈できない文字列で NaN を返す。isValidCandleTimestamp が弾く
      // （状態ファイルの lastTickAt が解釈できないときの advanceMs もここで落ちる）。
      if (!isValidCandleTimestamp(ms)) return reply.code(400).send({ error: "INVALID_CLOCK" });
      if (ms > maxMs) {
        return reply.code(400).send({
          error: "CLOCK_TOO_FAR_AHEAD",
          maxLastTickAt: new Date(maxMs).toISOString(),
        });
      }
    }
    if (virtual) {
      const floorMs = latestRecordMs(store.state());
      if (floorMs !== null && ms < floorMs) {
        return reply.code(400).send({
          error: "CLOCK_BEFORE_RECORDS",
          minLastTickAt: new Date(floorMs).toISOString(),
        });
      }
    }
    const lastTickAt = new Date(Math.trunc(ms)).toISOString();
    await store.commit({
      ...store.state(),
      lastTickAt,
      updatedAt: new Date(realNowMs).toISOString(),
    });
    return { lastTickAt, previousLastTickAt };
  });

  fastify.post("/orders/:order_id/fill", async (request, reply) => {
    const orderId = String((request.params as { order_id: string }).order_id);
    const body = asRecord(request.body) ?? {};
    const store = fastify.store;
    const order = store.state().orders.find((o) => o.id === orderId);
    if (!order) return reply.code(404).send({ error: "ORDER_NOT_FOUND" });
    if (!isActive(order)) {
      return reply.code(409).send({ error: "ORDER_NOT_ACTIVE", status: order.status });
    }

    const remaining = remainingOf(order);
    const digits = precisionOf(order.pair);
    const price = body.price === undefined ? order.price : Number(body.price);
    if (price == null || !Number.isFinite(price) || price <= 0) {
      return reply.code(400).send({ error: "INVALID_PRICE" });
    }
    if (body.price !== undefined && !fitsDigits(price, digits.priceDigits)) {
      return reply.code(400).send({ error: "INVALID_PRICE" });
    }

    let amount = remaining;
    if (body.amount !== undefined) {
      amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount <= 0 || amount > remaining) {
        return reply.code(400).send({ error: "INVALID_AMOUNT", remaining });
      }
      if (!fitsDigits(amount, digits.amountDigits)) {
        return reply.code(400).send({ error: "INVALID_AMOUNT", remaining });
      }
    }

    const before = store.state();
    const at = new Date(store.now()).toISOString();
    const r = fillOrder(before, orderId, price, amount, at, store.feeRate);
    if (!r.success) {
      if (r.error === "INVALID_AMOUNT") {
        return reply.code(400).send({ error: "INVALID_AMOUNT", remaining });
      }
      if (r.error === "INVALID_PRICE") return reply.code(400).send({ error: "INVALID_PRICE" });
      if (r.error === "ORDER_NOT_ACTIVE") {
        return reply.code(409).send({ error: "ORDER_NOT_ACTIVE", status: order.status });
      }
      return reply.code(400).send({ error: r.error });
    }
    await store.commit(r.data.state);
    return {
      order: formatOrder(r.data.order),
      trade: r.data.trade ? formatTrade(r.data.trade) : null,
    };
  });

  /**
   * 注文を `REJECTED` にする（`rejectOrder()`）。`fill` と対になる口で、応答も `fill` の
   * `order` と同じ形（`{ order }`。約定は起きないので `trade` は持たない）。本文は読まない。
   *
   * 受け付けるのは `UNFILLED` と `INACTIVE` だけで、どの状態を受けるかは `rejectOrder()` が
   * 決める（ここで同じ集合を持ち直さない）。部分約定済みの注文を断るのは不変量 2
   * （`REJECTED` の約定量は 0）のため。拘束は active な注文から計算するので、`REJECTED` に
   * した時点で外れる。
   *
   * - 存在しない: 404 `ORDER_NOT_FOUND`
   * - 受け付けない状態: 409 `ORDER_NOT_ACTIVE`（`status` を添える）
   *
   * private stream には、状態の差から `REJECTED` の `spot_order` と拘束が外れた資産の
   * `asset_update` が流れる（公式の stream の status の列挙には `REJECTED` が無い。
   * `docs/fidelity.md` の「private stream の注文ペイロード」節）。
   */
  fastify.post("/orders/:order_id/reject", async (request, reply) => {
    const orderId = String((request.params as { order_id: string }).order_id);
    const store = fastify.store;
    const before = store.state();
    const order = before.orders.find((o) => o.id === orderId);
    if (!order) return reply.code(404).send({ error: "ORDER_NOT_FOUND" });

    const r = rejectOrder(before, orderId, new Date(store.now()).toISOString());
    if (!r.success) {
      return reply.code(409).send({ error: "ORDER_NOT_ACTIVE", status: order.status });
    }
    await store.commit(r.data.state);
    return { order: formatOrder(r.data.order) };
  });

  /*
   * private stream の保留・再送。公式が保証しない順序の入れ替わり・重複・欠落を、利用側が
   * 狙ったとおりに起こすための口（`docs/fidelity.md` の「private stream の保留・再送」節）。
   * 中身は hub のメモリにあり、`PaperState` にも状態ファイルにも入らない。そのため劣化中も
   * 通す（`src/server/degraded.ts` の `NON_PERSISTING_CONTROL_ROUTES`）。
   */

  /**
   * 保留を始める。以後の変化のメッセージは送らずに溜める（購読者が 0 人でも溜める）。
   * 既に保留中なら何もしない（溜めたものは捨てない）。本文は読まない。
   */
  fastify.post("/stream/hold", async () => fastify.privateStream.hold());

  /**
   * 保留の状況と、溜めたメッセージを溜めた順に番号（`seq`、1 から）付きで返す。新しい接続を
   * 受け付けているか（`accepting`。下の refuse / accept）も添える——確かめる口を別に作らず、
   * stream の実験の様子を 1 回で読めるようにするため。
   */
  fastify.get("/stream/held", async () => ({
    ...fastify.privateStream.holdStatus(),
    accepting: fastify.privateStream.isAccepting(),
    messages: fastify.privateStream.heldMessages(),
  }));

  /**
   * 溜めたものを `order` の番号の順に、その時点で接続している全員へ送り、保留を解く。
   * 同じ番号を 2 度書けば重複、書かなかった番号は欠落。`order` を省略したら溜めた順にすべて。
   *
   * - 保留していない: 409 `NOT_HOLDING`
   * - 上限に達して落とした変化がある: 409 `STREAM_HOLD_OVERFLOWED`（保留は解かない。抜け出すのは
   *   `POST /_control/reset`）
   * - `order` の形・範囲・長さが違う: 400 `INVALID_RELEASE_ORDER`
   * - 送るものが 1 通以上あるのに接続が 0 本: 409 `NO_STREAM_CLIENTS`（繋いでから送り直すか、
   *   捨てたいなら `order: []`）
   *
   * 断ったときは保留も溜めたものもそのまま残す。
   */
  fastify.post("/stream/release", async (request, reply) => {
    const hub = fastify.privateStream;
    const order = releaseOrder(request.body);
    const invalid = () => {
      const { held, limit } = hub.holdStatus();
      return reply.code(400).send({ error: "INVALID_RELEASE_ORDER", held, limit });
    };
    if (order === null) return invalid();
    const r = hub.release(order);
    if (r.success) return r.data;
    if (r.error === "NOT_HOLDING") return reply.code(409).send({ error: "NOT_HOLDING" });
    if (r.error === "OVERFLOWED") {
      const { limit, dropped } = hub.holdStatus();
      return reply.code(409).send({ error: "STREAM_HOLD_OVERFLOWED", limit, dropped });
    }
    if (r.error === "NO_CLIENTS") {
      return reply.code(409).send({ error: "NO_STREAM_CLIENTS", held: hub.holdStatus().held });
    }
    return invalid();
  });

  /*
   * private stream の切断。状態を残したまま接続を切り、切ったまま繋がらない時間を作るための口
   * （`docs/fidelity.md` の「private stream の切断」節）。受け付けるかどうかは hub のメモリにあり、
   * `PaperState` にも状態ファイルにも入らない。そのため劣化中も通す
   * （`src/server/degraded.ts` の `NON_PERSISTING_CONTROL_ROUTES`）。reset で受け付ける状態に戻る。
   *
   * 切ったまま保つなら **refuse → disconnect の順**に呼ぶ。逆だと、その間に利用側が繋ぎ直し得る。
   */

  /**
   * 接続中の全員を close code 1001 で閉じ、閉じた数を `{ closed }` で返す。0 本でも 200
   * （失うものが無い）。状態・保留・溜めたもの・受け付けるかどうかには触れない。本文は読まない。
   */
  fastify.post("/stream/disconnect", async () => ({
    closed: fastify.privateStream.disconnectAll(),
  }));

  /**
   * 新しい接続を受け付けない状態にする（`GET /_stream/private` が 503 になる）。今の接続は
   * 閉じない。何度呼んでも同じ応答 `{ accepting: false }`。本文は読まない。
   */
  fastify.post("/stream/refuse", async () => {
    fastify.privateStream.refuse();
    return { accepting: fastify.privateStream.isAccepting() };
  });

  /** 受け付ける状態に戻す。何度呼んでも同じ応答 `{ accepting: true }`。本文は読まない。 */
  fastify.post("/stream/accept", async () => {
    fastify.privateStream.accept();
    return { accepting: fastify.privateStream.isAccepting() };
  });

  /*
   * REST の障害注入。互換ルートの「次の N 回の（メソッド, パス）」に、429・5xx・応答不明・
   * 状態を変えたうえでの 5xx を起こす（`docs/fidelity.md` の「REST の障害注入」節）。登録は
   * `FaultInjector` のメモリにあり、`PaperState` にも状態ファイルにも入らない。そのため劣化中も
   * 通す（`src/server/degraded.ts` の `NON_PERSISTING_CONTROL_ROUTES`）。reset で捨てる。
   */

  /**
   * 登録する。本文は `{ method, path, kind, count?, status? }`（形は `FaultInjector.register()`）。
   *
   * - 形が違う・知らないキーがある: 400 `INVALID_FAULT`
   * - （メソッド, パス）が互換ルートでない（`/_control/` と `/_stream/private` を含む）・モックに無い:
   *   400 `INVALID_FAULT_TARGET`。当てられる（メソッド, パス）の一覧を `targets` に添える
   */
  fastify.post("/faults", async (request, reply) => {
    const r = opts.faults.register(request.body);
    if (r.success) return { fault: r.data };
    if (r.error === "INVALID_FAULT_TARGET") {
      return reply
        .code(400)
        .send({ error: "INVALID_FAULT_TARGET", targets: opts.faults.targetKeys() });
    }
    return reply.code(400).send({ error: "INVALID_FAULT" });
  });

  /** 登録した順に返す。残り回数が 0 になった登録も、当たった回数（`hits`）を付けて残す。 */
  fastify.get("/faults", async () => ({ faults: opts.faults.list() }));

  /** 1 件取り消す。無ければ 404 `FAULT_NOT_FOUND`。 */
  fastify.delete("/faults/:id", async (request, reply) => {
    const id = faultId((request.params as { id?: unknown }).id);
    const removed = id === null ? null : opts.faults.cancel(id);
    if (removed === null) return reply.code(404).send({ error: "FAULT_NOT_FOUND" });
    return { fault: removed };
  });

  /** すべて取り消す。 */
  fastify.delete("/faults", async () => ({ removed: opts.faults.clear() }));
};
