import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { PassThrough, type Readable } from "node:stream";
import { errorCodes, type FastifyInstance } from "fastify";
import { ErrorCode, type ErrorCodeValue, err } from "../routes/envelope.ts";
import type { ApiCredentials } from "./config.ts";

/**
 * 認証ヘッダの検証（`docs/plan-lab-mock.md` 19.2 の決定 37〜43。挙動の正は `docs/fidelity.md` の
 * 「認証」節）。`BITBANK_MOCK_API_KEY` と `BITBANK_MOCK_API_SECRET` を両方設定したときだけ有効になり、
 * 既定では何も見ない。
 *
 * 公式 rest-api.md の「Authorization」（日本語版「認証」）の 2 方式を受ける。
 *
 * | 方式 | ヘッダ | 署名対象（GET） | 署名対象（POST） |
 * | --- | --- | --- | --- |
 * | ACCESS-TIME-WINDOW | `ACCESS-KEY` / `ACCESS-REQUEST-TIME` / `ACCESS-TIME-WINDOW` / `ACCESS-SIGNATURE` | 時刻 + 窓 + パスとクエリ | 時刻 + 窓 + 本文 |
 * | ACCESS-NONCE | `ACCESS-KEY` / `ACCESS-NONCE` / `ACCESS-SIGNATURE` | nonce + パスとクエリ | nonce + 本文 |
 *
 * 署名は API シークレットを鍵にした HMAC-SHA256 の 16 進。**パスとクエリは要求行の生の文字列、本文は
 * 届いたバイト列をそのまま**使う（決定 39）。解析した値から組み直すと、クエリの並びや本文の空白・
 * キーの順が違う要求まで通してしまい、中継が要求を書き換えたことを見逃す。
 */

/** 認証を求める経路の接頭辞。**互換ルートだけ**（決定 41。`GET /v1/user/subscribe` も入る）。 */
const TARGET_PREFIX = "/v1/user/";

/** `ACCESS-TIME-WINDOW` を省いたときの値（公式 "If not specified, 5000 will be applied by default."）。 */
export const DEFAULT_TIME_WINDOW_MS = 5000;

/** `ACCESS-TIME-WINDOW` の上限（公式 "The maximum value cannot exceed 60000."）。超えたら断る。 */
export const MAX_TIME_WINDOW_MS = 60_000;

/**
 * `ACCESS-REQUEST-TIME` がサーバの時刻より先にあってよい幅（未満）。公式の判定式
 * `ACCESS-REQUEST-TIME < (serverTime + 1000) && (serverTime - ACCESS-REQUEST-TIME) <= ACCESS-TIME-WINDOW`
 * の `1000` である。
 */
export const MAX_REQUEST_TIME_AHEAD_MS = 1000;

/**
 * 断った理由。ログにはこの固定の語だけを出す（決定 43）。**シークレット・署名・署名対象の文字列は
 * 出さない**——ヘッダの値も、どれだけ時刻がずれていたかも出さない。
 */
export type AuthFailureReason =
  | "missing ACCESS-KEY"
  | "unknown ACCESS-KEY"
  | "missing ACCESS-REQUEST-TIME"
  | "invalid ACCESS-REQUEST-TIME"
  | "ACCESS-REQUEST-TIME outside the time window"
  | "invalid ACCESS-TIME-WINDOW"
  | "missing ACCESS-NONCE"
  | "invalid ACCESS-NONCE"
  | "ACCESS-NONCE not increasing"
  | "missing ACCESS-SIGNATURE"
  | "signature mismatch";

export type AuthResult =
  | { ok: true }
  | { ok: false; code: ErrorCodeValue; reason: AuthFailureReason };

/** 検証に要る、要求 1 本ぶんの値。 */
export type AuthRequest = {
  /** 要求行のパスとクエリ。**生のまま**（`/v1` を含む）。 */
  rawUrl: string;
  /** 届いた本文のバイト列。**生のまま**。`POST` だけが持ち、`GET` / `HEAD` は `undefined`。 */
  body: Buffer | undefined;
  headers: IncomingHttpHeaders;
};

/** 整数の値として受ける形。符号も小数点も指数も受けない（公式は「整数値」とだけ書く）。 */
const INTEGER = /^[0-9]+$/;

/** 署名の形。`openssl dgst` と Node の `digest("hex")` が出す小文字の 16 進 64 桁だけを受ける。 */
const SIGNATURE = /^[0-9a-f]{64}$/;

/** ヘッダの値。無いときと空文字のときは `undefined`（どちらも「付いていない」として扱う）。 */
function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name];
  return typeof v === "string" && v !== "" ? v : undefined;
}

const fail = (code: ErrorCodeValue, reason: AuthFailureReason): AuthResult => ({
  ok: false,
  code,
  reason,
});

/** 長さの違いを漏らさずに比べるため、両方を同じ長さのハッシュにしてから比べる。 */
function sameSecretText(a: string, b: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * 認証ヘッダを検証する。1 つのキーとシークレットを持ち、ACCESS-NONCE 方式の直近の nonce を
 * **メモリにだけ**持つ（`docs/plan-lab-mock.md` 19.5。状態ファイルには書かず、
 * `POST /_control/reset` でも捨てない——nonce はクライアント側の数列で、シナリオを初期化しても
 * 戻らないため。再起動で消える）。
 *
 * 時刻の窓は**実時刻**で判定する（決定 40）。仮想時計（`BITBANK_MOCK_CLOCK=virtual`）は見ない——
 * クライアントは自分の実時刻で署名するため。`now` はテストが窓の境界を踏むためだけにある。
 */
export class AuthVerifier {
  private lastNonce: bigint | null = null;
  private readonly now: () => number;

  constructor(
    private readonly credentials: ApiCredentials,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * 判定の順は次のとおり（`docs/fidelity.md` の「認証」節）。最初に当たったもので断る。
   *
   * 1. `ACCESS-KEY` が無い → `20003`、設定したキーと違う → `20002`
   * 2. 方式を決める。`ACCESS-REQUEST-TIME` か `ACCESS-TIME-WINDOW` があれば ACCESS-TIME-WINDOW 方式
   *    （公式「どちらも指定した場合は ACCESS-TIME-WINDOW 方式が優先」）、無ければ ACCESS-NONCE 方式
   * 3. 方式のヘッダ。TIME-WINDOW: 時刻が無い → `20033`、整数でない → `20034`、窓が整数でないか
   *    上限超え → `20001`、窓の外 → `20034`。NONCE: 無い → `20004`、整数でない → `20001`
   * 4. `ACCESS-SIGNATURE` が無い・合わない → `20005`
   * 5. NONCE 方式で、nonce が前回受け付けた値より大きくない → `20001`。**署名が合った要求だけ**を
   *    数える（署名の無い要求で記録を動かさない）。通ったら記録する
   */
  verify(req: AuthRequest): AuthResult {
    const { headers } = req;
    const key = header(headers, "access-key");
    if (key === undefined) return fail(ErrorCode.INVALID_PARAMETER, "missing ACCESS-KEY");
    if (!sameSecretText(key, this.credentials.key)) {
      return fail(ErrorCode.INVALID_ACCESS_KEY, "unknown ACCESS-KEY");
    }

    const requestTime = header(headers, "access-request-time");
    const timeWindow = header(headers, "access-time-window");
    let prefix: string;
    let nonce: bigint | null = null;
    if (requestTime !== undefined || timeWindow !== undefined) {
      if (requestTime === undefined) {
        return fail(ErrorCode.ACCESS_REQUEST_TIME_NOT_FOUND, "missing ACCESS-REQUEST-TIME");
      }
      if (!INTEGER.test(requestTime)) {
        return fail(ErrorCode.INVALID_ACCESS_REQUEST_TIME, "invalid ACCESS-REQUEST-TIME");
      }
      if (timeWindow !== undefined && !INTEGER.test(timeWindow)) {
        return fail(ErrorCode.INVALID_AUTH, "invalid ACCESS-TIME-WINDOW");
      }
      const windowMs = timeWindow === undefined ? DEFAULT_TIME_WINDOW_MS : Number(timeWindow);
      if (windowMs > MAX_TIME_WINDOW_MS) {
        return fail(ErrorCode.INVALID_AUTH, "invalid ACCESS-TIME-WINDOW");
      }
      // 公式の判定式をそのまま写す（未来側は 1000 ミリ秒未満、過去側は窓の幅以下）。
      const serverTime = this.now();
      const t = Number(requestTime);
      if (!(t < serverTime + MAX_REQUEST_TIME_AHEAD_MS && serverTime - t <= windowMs)) {
        return fail(
          ErrorCode.INVALID_ACCESS_REQUEST_TIME,
          "ACCESS-REQUEST-TIME outside the time window",
        );
      }
      // 窓を省いた要求は、既定値の 5000 を連結した文字列に署名したものとして見る（推測。
      // `docs/fidelity.md` の「認証」節）。
      prefix = requestTime + (timeWindow ?? String(DEFAULT_TIME_WINDOW_MS));
    } else {
      const raw = header(headers, "access-nonce");
      if (raw === undefined) return fail(ErrorCode.ACCESS_NONCE_NOT_FOUND, "missing ACCESS-NONCE");
      if (!INTEGER.test(raw)) return fail(ErrorCode.INVALID_AUTH, "invalid ACCESS-NONCE");
      nonce = BigInt(raw);
      prefix = raw;
    }

    const signature = header(headers, "access-signature");
    if (signature === undefined) {
      return fail(ErrorCode.INVALID_ACCESS_SIGNATURE, "missing ACCESS-SIGNATURE");
    }
    const hmac = createHmac("sha256", this.credentials.secret).update(prefix);
    // GET（と Fastify が GET から作る HEAD）はパスとクエリ、POST は本文。どちらも生のまま。
    if (req.body === undefined) hmac.update(req.rawUrl);
    else hmac.update(req.body);
    const expected = hmac.digest();
    if (!SIGNATURE.test(signature) || !timingSafeEqual(Buffer.from(signature, "hex"), expected)) {
      return fail(ErrorCode.INVALID_ACCESS_SIGNATURE, "signature mismatch");
    }

    if (nonce !== null) {
      if (this.lastNonce !== null && nonce <= this.lastNonce) {
        return fail(ErrorCode.INVALID_AUTH, "ACCESS-NONCE not increasing");
      }
      this.lastNonce = nonce;
    }
    return { ok: true };
  }
}

/**
 * 本文を読み切ってバイト列で返す。上限を超えたら Fastify 自身と同じ 413 の誤り
 * （`FST_ERR_CTP_BODY_TOO_LARGE`）で断る——検証のために本文を先に読むので、Fastify の上限の検査より
 * 前に来る。`declared` は `content-length` の値（無ければ `NaN`）で、超えると読む前に断る。
 * 超えた分は読み捨てる（Fastify の本文の読み取りと同じく、ストリームは壊さない）。
 *
 * 公開しているのはテストが上限と読み取りの失敗を直接踏むためだけ。
 */
export function readRawBody(payload: Readable, limit: number, declared: number): Promise<Buffer> {
  if (declared > limit) return Promise.reject(new errorCodes.FST_ERR_CTP_BODY_TOO_LARGE());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      payload.off("data", onData);
      payload.off("end", onEnd);
      payload.off("error", onError);
    };
    // 要求のストリームには文字コードを付けていないので、届くのは Buffer だけ。
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        reject(new errorCodes.FST_ERR_CTP_BODY_TOO_LARGE());
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (e: Error) => {
      cleanup();
      reject(e);
    };
    payload.on("data", onData);
    payload.on("end", onEnd);
    payload.on("error", onError);
  });
}

/** 読み切った本文を、Fastify の本文の解析へ渡し直すためのストリームにする。 */
function replay(body: Buffer): Readable {
  const stream = new PassThrough();
  stream.end(body);
  return stream;
}

/**
 * 認証のフックを足す。**REST の障害注入（`registerFaultInjection()`）より先に呼ぶ**（決定 42）。
 *
 * `preParsing`（本文の解析の直前）で見る。`onRequest` では POST の本文がまだ読めず、
 * `preValidation` 以降では Fastify が本文を JSON として解析した後で、生のバイト列が残らない。
 * ここで本文を読み切って検証し、読んだバイト列を新しいストリームとして解析へ渡し直す。
 *
 * - 障害注入は同じ `preParsing` に後から足すので、**認証に通らない要求には故障が当たらず、回数も
 *   減らない**。Fastify は応答を送り終えた要求の残りの `preParsing` を走らせない
 * - 劣化の判定（`src/server/http.ts` の `registerDegradedGuard()`）は `preHandler` / `preSerialization`
 *   なので、劣化中も認証が先に出る。ハンドラへ入らないので状態も変えない。本文は**文字列で**渡す——
 *   オブジェクトで渡すと劣化の判定の `preSerialization` が走り、劣化中の状態を変える経路では
 *   `70001` に差し替えてしまう（障害注入の 429 と同じ手当て）
 * - 断った応答は互換ルートの他の失敗と同じく HTTP 200 + 封筒（`docs/fidelity.md` の「認証」節）
 */
export function registerAuth(fastify: FastifyInstance, verifier: AuthVerifier): void {
  fastify.addHook("preParsing", async (request, reply, payload) => {
    const url = request.routeOptions.url;
    if (url === undefined || !url.startsWith(TARGET_PREFIX)) return payload;
    const body =
      request.method === "POST"
        ? await readRawBody(
            payload,
            request.routeOptions.bodyLimit,
            Number(request.headers["content-length"]),
          )
        : undefined;
    const rawUrl = request.raw.url ?? "";
    const result = verifier.verify({ rawUrl, body, headers: request.headers });
    if (result.ok) return body === undefined ? payload : replay(body);
    // 理由とメソッドとパス（クエリは除く）だけを出す（決定 43）。
    request.log.warn(
      { method: request.method, path: rawUrl.split("?")[0] },
      `auth rejected: ${result.reason}`,
    );
    return reply
      .code(200)
      .type("application/json; charset=utf-8")
      .send(JSON.stringify(err(result.code)));
  });
}
