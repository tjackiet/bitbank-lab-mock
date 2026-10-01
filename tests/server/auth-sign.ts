import { createHmac } from "node:crypto";

/**
 * テストが送る要求に付ける認証ヘッダを作る。**公式 rest-api.md の「Authorization」節（日本語版
 * 「認証」節）の記述だけから組む**——`src/server/auth.ts` も、利用側のクライアント（bitbank-lab-mcp
 * など）のコードも使わない。モックの実装を写して作ると、実装と同じ誤りを持った署名が通ってしまい、
 * 検証にならない。
 *
 * 公式の記述（コミット `0badd680`）:
 *
 * - 署名は「以下の文字列を `HMAC-SHA256` 形式で API シークレットキーを使って署名した結果」。
 *   サンプルは `openssl dgst -sha256 -hmac "$API_SECRET"` の出力（小文字の 16 進）
 * - ACCESS-TIME-WINDOW 方式: GET は「ACCESS-REQUEST-TIME、ACCESS-TIME-WINDOW、リクエストのパス、
 *   クエリパラメータ」、POST は「ACCESS-REQUEST-TIME、ACCESS-TIME-WINDOW、リクエストボディの Json
 *   文字列」を連結したもの
 * - ACCESS-NONCE 方式: GET は「ACCESS-NONCE、リクエストのパス、クエリパラメータ」、POST は
 *   「ACCESS-NONCE、リクエストボディの Json 文字列」を連結したもの
 * - GET の「リクエストのパス」には `/v1` を含める
 *
 * 公式のサンプルの値（`OFFICIAL_SAMPLES`）で、この関数が公式と同じ署名を出すことを
 * `tests/server/auth.test.ts` が確かめる。
 */

/** `openssl dgst -sha256 -hmac "$secret"` に `echo -n "$message"` を流したときの出力と同じ。 */
export function hmacHex(secret: string, message: string): string {
  return createHmac("sha256", secret).update(message).digest("hex");
}

export type SignTarget =
  /** GET: パスとクエリ（`/v1` を含む）。 */
  | { path: string }
  /** POST: 本文の JSON 文字列。 */
  | { body: string };

const targetText = (t: SignTarget): string => ("path" in t ? t.path : t.body);

/** ACCESS-TIME-WINDOW 方式のヘッダ。`timeWindow` の既定は公式の既定値 `5000`。 */
export function timeWindowHeaders(opts: {
  key: string;
  secret: string;
  requestTime: string;
  timeWindow?: string;
  target: SignTarget;
}): Record<string, string> {
  const timeWindow = opts.timeWindow ?? "5000";
  return {
    "ACCESS-KEY": opts.key,
    "ACCESS-REQUEST-TIME": opts.requestTime,
    "ACCESS-TIME-WINDOW": timeWindow,
    "ACCESS-SIGNATURE": hmacHex(
      opts.secret,
      opts.requestTime + timeWindow + targetText(opts.target),
    ),
  };
}

/** ACCESS-NONCE 方式のヘッダ。 */
export function nonceHeaders(opts: {
  key: string;
  secret: string;
  nonce: string;
  target: SignTarget;
}): Record<string, string> {
  return {
    "ACCESS-KEY": opts.key,
    "ACCESS-NONCE": opts.nonce,
    "ACCESS-SIGNATURE": hmacHex(opts.secret, opts.nonce + targetText(opts.target)),
  };
}

/**
 * 公式のサンプル（rest-api.md / rest-api_JP.md の「Sample」節。英日で同じ値）。
 * `API_SECRET="hoge"`、時刻と nonce は `1721121776490`、窓は `1000`。
 */
export const OFFICIAL_SAMPLES = {
  secret: "hoge",
  requestTime: "1721121776490",
  timeWindow: "1000",
  nonce: "1721121776490",
  path: "/v1/user/assets",
  body: '{"pair": "xrp_jpy", "price": "20", "amount": "1","side": "buy", "type": "limit"}',
  signatures: {
    timeWindowGet: "9ec5745960d05573c8fb047cdd9191bd0c6ede26f07700bb40ecf1a3920abae8",
    timeWindowPost: "7868665738ae3f8a796224e0413c1351ddd7ec2af121db12815c0a5b74b8764c",
    nonceGet: "f957817b95c3af6cf5e2e9dfe1503ea8088f46879d4ab73051467fd7b94f1aba",
    noncePost: "8ef83c2b991765b18c95aade7678471747c06890a23a453c76238345b5c86fb8",
  },
} as const;
