import { STATUS_CODES } from "node:http";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ErrorCode, err } from "../routes/envelope.ts";
import type { SessionStore } from "../store/session.ts";
import { routeKey } from "./degraded.ts";

/**
 * REST の障害注入。`/_control/faults` に「次の N 回の（メソッド, パス）に、この種類の故障を起こす」を
 * 登録し、互換ルートへの要求が当たるたびに残り回数を 1 減らす（`docs/plan-lab-mock.md` 18.2 の
 * 決定 29〜34・36。挙動の正は `docs/fidelity.md` の「REST の障害注入」節）。
 *
 * **乱数も時間も使わない。** 指定したとおりにしか起きないので、同じシナリオが毎回同じ結果になる
 * （private stream の保留・再送と同じ性質。17.2 の決定 19）。
 */

/**
 * 故障の種類（決定 30）。
 *
 * - `rate_limit`: 状態を変えずに HTTP 429 + 封筒 `10009`
 * - `server_error`: 状態を変えずに 5xx
 * - `no_response`: 状態を変え（private stream の配信と状態ファイルへの書き出しまで済ませ）、
 *   応答を返さずに接続を切る
 * - `server_error_after_apply`: 状態を変えたうえで、応答の代わりに 5xx を返す（本文は `server_error` と同じ）
 */
export const FAULT_KINDS = [
  "rate_limit",
  "server_error",
  "no_response",
  "server_error_after_apply",
] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

/** 5xx の種類で `status` を省いたときの値。 */
export const DEFAULT_SERVER_ERROR_STATUS = 500;

/** 故障を当てられる経路の接頭辞。**互換ルートだけ**（決定 31）。 */
const TARGET_PREFIX = "/v1/user/";

/** 登録の本文で受けるキー。これ以外のキーがあれば断る（打ち間違いを既定値で黙って通さない）。 */
const SPEC_KEYS = new Set(["method", "path", "kind", "count", "status"]);

/** `GET /_control/faults` などが返す 1 件。 */
export type FaultView = {
  /** 登録の番号。プロセスの寿命のあいだ 1 から増え続け、reset でも振り直さない。 */
  id: number;
  method: string;
  path: string;
  kind: FaultKind;
  /** 返す HTTP ステータス。`rate_limit` は 429、`no_response` は応答が無いので `null`。 */
  status: number | null;
  /** 登録した回数。 */
  count: number;
  /** 残り回数。0 になっても一覧に残す（決定 33）。 */
  remaining: number;
  /** 当たった回数（`count - remaining`）。 */
  hits: number;
};

/** 要求に当たった故障。応答を作るのに要るものだけ。5xx の 2 種類だけがステータスを持つ。 */
export type FiredFault =
  | { kind: "rate_limit" }
  | { kind: "no_response" }
  | { kind: "server_error"; status: number }
  | { kind: "server_error_after_apply"; status: number };

type Registration = {
  id: number;
  /** `routeKey()` の形。要求と突き合わせるのに使う。 */
  key: string;
  method: string;
  path: string;
  fired: FiredFault;
  count: number;
  remaining: number;
};

export type RegisterResult =
  | { success: true; data: FaultView }
  | { success: false; error: "INVALID_FAULT" | "INVALID_FAULT_TARGET" };

function isFaultKind(x: unknown): x is FaultKind {
  return typeof x === "string" && (FAULT_KINDS as readonly string[]).includes(x);
}

function view(r: Registration): FaultView {
  const { id, method, path, fired, count, remaining } = r;
  const status = "status" in fired ? fired.status : fired.kind === "rate_limit" ? 429 : null;
  return { id, method, path, kind: fired.kind, status, count, remaining, hits: count - remaining };
}

/** 5xx の本文。**封筒にも JSON にも包まない**（`docs/fidelity.md` の「REST の障害注入」節）。 */
export function serverErrorBody(status: number): string {
  return STATUS_CODES[status] ?? "Server Error";
}

/**
 * 登録した故障を持ち、要求に当てる。**`PaperState` の外（メモリ）に持ち、reset で捨てる**（決定 33）。
 * 状態ファイルに書かないので、書き出しに失敗した後の劣化中も登録・参照・取消を通す（決定 34）。
 */
export class FaultInjector {
  /** 故障を当てられる（メソッド, パス）。`routeKey()` の形。サーバが登録した互換ルートから集める。 */
  private readonly targets = new Set<string>();
  private registrations: Registration[] = [];
  private nextId = 1;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly store: SessionStore) {}

  /** サーバが経路を登録するたびに呼ぶ（`registerFaultInjection()` の `onRoute`）。互換ルートだけ拾う。 */
  addRoute(method: string, url: string): void {
    if (url.startsWith(TARGET_PREFIX)) this.targets.add(routeKey(method, url));
  }

  /** 故障を当てられる（メソッド, パス）の一覧。登録を断ったときに応答へ添える。 */
  targetKeys(): string[] {
    return [...this.targets].sort();
  }

  /** store の購読を始める（reset で登録を捨てるため）。2 回呼んでも購読は 1 本。 */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.store.onStateChange((change) => {
      // 前の実験で使い残した登録を、次のシナリオの最初の要求に当てない（17.2 の決定 21 と同じ考え方）。
      if (change.kind === "reset") this.registrations = [];
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /**
   * 登録する。本文の形が違えば `INVALID_FAULT`、（メソッド, パス）が故障を当てられる経路でなければ
   * `INVALID_FAULT_TARGET`。形を先に見る。
   *
   * - `method` / `path` は文字列で、登録済みの互換ルートと完全に一致すること（大文字小文字を
   *   区別し、クエリ付きのパスは一致しない。`HEAD` は `GET` と同じ鍵）
   * - `kind` は `FAULT_KINDS` のどれか
   * - `count` は省略で 1、正の安全な整数（文字列の `"1"` は数へ強制しない）
   * - `status` は 5xx の種類だけが受け、省略で 500、500〜599 の整数
   * - 上に無いキーがあれば断る
   */
  register(body: unknown): RegisterResult {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { success: false, error: "INVALID_FAULT" };
    }
    const spec = body as Record<string, unknown>;
    if (Object.keys(spec).some((k) => !SPEC_KEYS.has(k))) {
      return { success: false, error: "INVALID_FAULT" };
    }
    const { method, path, kind, count = 1, status } = spec;
    if (typeof method !== "string" || typeof path !== "string" || !isFaultKind(kind)) {
      return { success: false, error: "INVALID_FAULT" };
    }
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) {
      return { success: false, error: "INVALID_FAULT" };
    }
    let fired: FiredFault;
    if (kind === "server_error" || kind === "server_error_after_apply") {
      const s = status === undefined ? DEFAULT_SERVER_ERROR_STATUS : status;
      if (typeof s !== "number" || !Number.isInteger(s) || s < 500 || s > 599) {
        return { success: false, error: "INVALID_FAULT" };
      }
      fired = { kind, status: s };
    } else {
      if (status !== undefined) return { success: false, error: "INVALID_FAULT" };
      fired = { kind };
    }
    const key = routeKey(method, path);
    if (!this.targets.has(key)) return { success: false, error: "INVALID_FAULT_TARGET" };
    const r: Registration = {
      id: this.nextId++,
      key,
      // 鍵から取り直すので、`HEAD` で登録しても一覧には `GET` で出る。
      method: key.slice(0, key.indexOf(" ")),
      path,
      fired,
      count,
      remaining: count,
    };
    this.registrations.push(r);
    return { success: true, data: view(r) };
  }

  /** 登録した順（`id` の昇順）に返す。残りが 0 の登録も含む。 */
  list(): FaultView[] {
    return this.registrations.map(view);
  }

  /** 1 件取り消す。無ければ `null`。 */
  cancel(id: number): FaultView | null {
    const removed = this.registrations.find((r) => r.id === id);
    if (!removed) return null;
    this.registrations = this.registrations.filter((r) => r !== removed);
    return view(removed);
  }

  /** すべて取り消し、取り消した件数を返す。 */
  clear(): number {
    const n = this.registrations.length;
    this.registrations = [];
    return n;
  }

  /**
   * 要求 1 本ぶんの故障を取り出す。**同じ（メソッド, パス）の登録は、登録した順に使い切る**
   * （決定 29）。残りのある最初の登録を 1 減らして返す。当たらなければ `null`。
   */
  take(method: string, url: string): FiredFault | null {
    const key = routeKey(method, url);
    const r = this.registrations.find((x) => x.remaining > 0 && x.key === key);
    if (!r) return null;
    r.remaining -= 1;
    return r.fired;
  }
}

/**
 * 故障を当てるフックを足す。**互換ルートを登録する前に呼ぶ**（`onRoute` で対象を集めるため）。
 *
 * - `onRequest`: 故障を取り出す。**劣化の判定（`preHandler`）より前**なので、劣化中でも故障が先に
 *   当たり、回数も減る（決定 34）。429 と 5xx は**ハンドラへ入る前に**ここで返す——ハンドラの中の
 *   `store.tick()` が market モードで約定を起こさないように（決定 30）。本文の解析より前でもあるので、
 *   壊れた本文の要求にも当たる（要求の中身に依らず当たる。決定 29）
 * - `onSend`: 応答不明と「状態を変えたうえで 5xx」。ハンドラ（と状態ファイルへの書き出し）を
 *   最後まで通した後、送る直前に接続を切るか、応答を 5xx に差し替える。劣化中にハンドラへ入れず
 *   `70001` を返した要求も同じく切るか差し替える（状態はもともと変わらない）
 *
 * 保留中の private stream との間に特例は無い（決定 36）。状態の差し替えが溜まるだけである。
 */
export function registerFaultInjection(fastify: FastifyInstance, injector: FaultInjector): void {
  /** ハンドラの後で応答を切るか差し替える故障。`onRequest` で置き、`onSend` で取り出す。 */
  const pending = new WeakMap<
    FastifyRequest,
    Extract<FiredFault, { kind: "no_response" | "server_error_after_apply" }>
  >();

  fastify.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) injector.addRoute(method, route.url);
  });

  fastify.addHook("onRequest", async (request, reply) => {
    const url = request.routeOptions.url;
    if (url === undefined) return;
    const fault = injector.take(request.method, url);
    if (fault === null) return;
    // 応答不明はアクセスログに完了の行が出ないので、当たったことをここで残す（種類は固定の語）。
    request.log.info(`fault injected: ${fault.kind}`);
    // 本文は**文字列で**渡す。オブジェクトで渡すと劣化の判定の `preSerialization`
    // （`src/server/http.ts` の `registerDegradedGuard()`）が走り、劣化中の状態を変える経路では
    // この応答を `70001` に差し替えてしまう。故障は劣化より先に当てる（決定 34）。
    if (fault.kind === "rate_limit") {
      return reply
        .code(429)
        .type("application/json; charset=utf-8")
        .send(JSON.stringify(err(ErrorCode.TOO_MANY_REQUESTS)));
    }
    if (fault.kind === "server_error") {
      return reply
        .code(fault.status)
        .type("text/plain; charset=utf-8")
        .send(serverErrorBody(fault.status));
    }
    pending.set(request, fault);
  });

  fastify.addHook("onSend", async (request, reply, payload) => {
    const fault = pending.get(request);
    if (fault === undefined) return payload;
    pending.delete(request);
    if (fault.kind === "no_response") {
      // 応答を 1 バイトも書かずにソケットを閉じる。この後に Fastify が書こうとする応答は、
      // 閉じたソケットへの書き込みとして Node が捨てる。利用側の HTTP クライアントには
      // 「応答の無いまま切れた」と見える（Node の `http` は `socket hang up`、curl は
      // `Empty reply from server`）。
      reply.raw.destroy();
      return payload;
    }
    reply.code(fault.status).type("text/plain; charset=utf-8");
    return serverErrorBody(fault.status);
  });
}
