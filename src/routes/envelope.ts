export type Envelope<T> = { success: 1; data: T } | { success: 0; data: { code: number } };

export function ok<T>(data: T): Envelope<T> {
  return { success: 1, data };
}

/**
 * 失敗の封筒。**HTTP ステータスは触らない（互換ルートは常に 200）。**
 *
 * かつては「ルート層で弾いた欠落・不正値は 400、engine 層まで進んだ業務エラーは 200」と
 * 分けていたが、**実 API は区別せず 200 を返す**ことを実測した（2026-09-17、17 経路。
 * 欠落・数値でない値・不正なペア・注文が見つからない、のすべて）。失敗は封筒の
 * `success: 0` だけが表す。
 *
 * そのため互換ルートのハンドラは `reply` を受け取っていない。ステータスを触りたく
 * なったら、まず `docs/fidelity.md` の「エラーコード」節の実測を読むこと。
 *
 * 例外は経路が決まらない要求で、そこは 200 ではない（`/v1/` 直下の未知パスは
 * 実 API も 404 + 封筒 `10000`）。`/_control/` は bitbank API に無い口なので、
 * この規則の対象外（素の JSON + HTTP ステータス）。
 */
export function err(code: number): Envelope<never> {
  return { success: 0, data: { code } };
}

// 出典: https://github.com/bitbankinc/bitbank-api-docs/blob/0badd68019646171826625b074cfef4235c3e713/errors.md
// 公式と違う意味に流用しているコードは docs/fidelity.md の「エラーコード」節に記録する
// （**`20003` だけ**。`60004` の流用は廃止した）。errors.md に定義の無い番号は置かない。
export const ErrorCode = {
  /**
   * "Url not found."
   *
   * **かつて不正なペアに流用していたが、やめた**（`INVALID_ASSET` に移した）。実 API が
   * この番号を返すのは経路が見つからないときで、`GET /v1/nonexistent` を**認証ヘッダ無しで**
   * 叩くと `HTTP 404` + 封筒 `10000` を観測できる（2026-09-17）。
   * モックも未登録パスをこの封筒で返す（`src/server/http.ts` の `registerNotFoundHandler()`。
   * `/v1/user/` 配下だけは実 API に合わせて 200 + `20003`。`/_control/` は対象外）。
   */
  URL_NOT_FOUND: 10000,
  /**
   * "You sent requests too frequently. Retry later with decreased requests."（`errors.md:42`）。
   * 実 API はレート制限を超えた要求に **HTTP 429** とこの番号の封筒を返す（2026-09-17 に実測。
   * `docs/fidelity.md` の「レート制限」節）。
   *
   * **モックが返すのは `/_control/faults` で `rate_limit` を注入したときだけ**で、回数を数える
   * レート制限は持たない（`docs/plan-lab-mock.md` 18.2 の決定 32）。返す経路は
   * `src/server/faults.ts` の 1 か所で、HTTP ステータスを 429 にするのもそこである（`err()` は
   * ステータスに触らない）。
   */
  TOO_MANY_REQUESTS: 10009,
  INVALID_AUTH: 20001,
  INVALID_PARAMETER: 20003,
  MISSING_AMOUNT: 30001,
  MISSING_ORDER_ID: 30006,
  MISSING_ORDER_IDS: 30007,
  /** "Missing asset." 実 API は `pair` の欠落にこれを返す（2026-09-17 実測）。 */
  MISSING_ASSET: 30009,
  MISSING_PRICE: 30012,
  MISSING_SIDE: 30013,
  MISSING_TYPE: 30015,
  /**
   * "Invalid order quantity."（`errors.md:104`、コミット `0badd680`）。**`amount` の不正値**に返す。
   * 負・`0`・有限でない値・数値として読めない値・ペアの数量桁に収まらない値が、すべてここへ落ちる
   * （欠落だけは `30001` で別）。公式の "order quantity" は rest-api.md のパラメータ名 `amount` に当たる。
   *
   * **実 API がこの番号を返すことは実測していない**——発注は実弾になるため測れない。
   * errors.md の意味から選んだ**推測**である。ただし**改訂前の `20003`（桁溢れだけ `60004`）も
   * 実測ではなかった**ので、どちらも推測のまま公式の意味に近い方へ寄せた、という整理になる
   * （`docs/fidelity.md` の「エラーコード」節）。
   */
  INVALID_ORDER_AMOUNT: 40001,
  // 絞り込みパラメータごとの不正値コード（40006 / 40007 / 40008 / 40009 / 40022 の 5 つ。
  // 間に挟まる 40017 はペアのコードでこの群ではない）。**汎用の 20003 ではなくこれらを
  // 返すことを実 API で実測した**（docs/fidelity.md の「絞り込みパラメータの不正値」）。
  // 括弧内は errors.md の該当メッセージで、番号を同定した根拠。
  // パラメータ名との対応は src/routes/params.ts の QUERY_PARAM_CODES が持つ。
  INVALID_COUNT: 40006, // "Invalid count."
  INVALID_END: 40007, // "Invalid end param."
  INVALID_END_ID: 40008, // "Invalid end_id."
  INVALID_FROM_ID: 40009, // "Invalid from_id."
  /**
   * "Invalid order id." **`order_id` が id の形をしていないとき**に実 API が返す
   * （2026-09-17 実測。`GET /v1/user/spot/order` に `order_id=true` / `1.5` / 同名 2 本）。
   *
   * **`50009`（"Order not found."）とは別物**で、実 API は「読めない id」と
   * 「読めたが存在しない id」を分けている。モックは以前どちらも `50009` か `20003` に
   * していた（`docs/fidelity.md` の「パラメータの型強制」）。
   */
  INVALID_ORDER_ID: 40013,
  /**
   * "Invalid order id array." **`order_ids` が id の配列になっていないとき**に実 API が
   * 返す（2026-09-17 実測。`POST /v1/user/spot/orders_info` に `"1"` / `1` / `[1.5]` / `[]`）。
   *
   * **空配列も弾かれる**点に注意。モックは以前 `success: 1` と空の一覧を返していた。
   */
  INVALID_ORDER_ID_ARRAY: 40014,
  /**
   * "Too many orders are specified." **`cancel_orders` の `order_ids` が 30 件を超えたとき**に
   * 返す。上限そのものは公式のパラメータ表に書かれている（`rest-api.md:548`
   * "order ids. Up to 30 ids can be specified"、`rest-api_JP.md:556`
   * 「注文ID。最大30個まで指定可能」。いずれもコミット `0badd680`）。
   *
   * **超過したとき実 API がこの番号を返すことは実測していない。** 取消の実測には実弾の注文が
   * 要るため測れず、`errors.md:111` の番号と意味（「指定された注文が多すぎる」）から選んだ。
   *
   * **この上限は `cancel_orders` にだけある。** `orders_info`（Fetch multiple orders）の
   * `order_ids` には公式に上限の記載が無い（`rest-api.md:600` / `rest-api_JP.md:608` は
   * どちらも "order ids" / 「注文ID」だけ）。揃えたくなっても足さないこと
   * （`docs/fidelity.md` の「一括取消の件数上限」節）。
   */
  TOO_MANY_ORDERS: 40015,
  /** "Invalid asset." 実 API は不正なペアにこれを返す（2026-09-17 実測）。絞り込み群ではない。 */
  INVALID_ASSET: 40017,
  /**
   * "Invalid order price."（`errors.md:113`）。**`price` の不正値**に返す。非正・有限でない値・
   * 数値として読めない値・ペアの価格桁に収まらない値、それに指値なのに価格が使えない場合
   * （`LIMIT_PRICE_REQUIRED`）がここへ落ちる（欠落だけは `30012` で別）。
   *
   * **実測していない**。根拠と留保は `INVALID_ORDER_AMOUNT` と同じで、改訂前の `20003` も
   * 実測ではなかった（`docs/fidelity.md` の「エラーコード」節）。
   */
  INVALID_ORDER_PRICE: 40020,
  /**
   * "Invalid order side."（`errors.md:114`）。**`side` が `buy` / `sell` のどちらでもない**ときに返す
   * （欠落だけは `30013` で別）。**実測していない**（留保は `INVALID_ORDER_AMOUNT` と同じ）。
   */
  INVALID_ORDER_SIDE: 40021,
  INVALID_SINCE: 40022, // "Invalid trading start time."
  /**
   * "Invalid order type."（`errors.md:116`）。**`type` が `limit` / `market` のどちらでもない**ときに
   * 返す（欠落だけは `30015` で別）。本モックは `stop` / `stop_limit` を実装しないので、それらも
   * ここへ落ちる。**実測していない**（留保は `INVALID_ORDER_AMOUNT` と同じ）。
   */
  INVALID_ORDER_TYPE: 40024,
  ORDER_NOT_FOUND: 50009,
  ALREADY_CANCELED: 50026,
  ALREADY_EXECUTED: 50027,
  INSUFFICIENT_FUNDS: 60001,
  // `60004`「Order quantity has exceeded the lower threshold.」＝**最小数量割れ**は、
  // ここに**意図して置いていない**。改訂前は数量の桁溢れに流用していたが、桁溢れは
  // `40001`（"Invalid order quantity."）へ移して番号を空けた。`/spot/pairs` の `unit_amount` を
  // 取得して最小数量の検査を入れるときに、**公式本来の意味で**使うためである。
  // **別の意味で埋め直さないこと**（`docs/fidelity.md` の「エラーコード」節）。

  /**
   * "Too many Simultaneous orders, current limit is 30."
   * **同時に持てる未約定注文の本数の上限**を超えた新規発注に返す（`errors.md:202`。
   * 日本語版 `errors_JP.md:202` は「同時発注制限件数(30件)を上回っています」）。
   * 上限の値 30 は公式の文言そのもので、設定可能にしない。
   *
   * **適用条件は公式ドキュメントから読み取れない。** この番号と意味は `errors.md` にしか無く、
   * `rest-api.md` / `rest-api_JP.md` の Create new order には一言も出てこない（固定コミット
   * `0badd680` で確認）。**数える単位を口座全体にしたのは推測である**——公式の文言が
   * "Simultaneous orders" でペアに言及しないうえ、口座全体の方が制限が強く fail-closed 側に
   * 倒れる。判定は `src/routes/create-order.ts`（`docs/fidelity.md` の「同時未約定注文の上限」節）。
   *
   * **`cancel_orders` の `40015` とは別の制限。** あちらは「1 要求あたりの `order_ids` が
   * 30 件まで」で、こちらは「口座が同時に持てる未約定注文が 30 本まで」である。
   * **同じ 30 なので混同されやすい**が、数える対象も断る経路も違う。
   */
  TOO_MANY_SIMULTANEOUS_ORDERS: 60011,
  INTERNAL: 70001,
  /**
   * "Orders on pair have been suspended." **発注停止のペアへの新規発注**に返す
   * （`errors.md:225`）。公式 `pairs.md` の "Order suspended flag (delisted)" 列が `true` の
   * 18 ペアが対象で、判定は `src/engine/pairs.ts` の `isOrderSuspendedPair()`。
   *
   * **停止ペアへ実際に発注したとき実 API がこの番号を返すことは実測していない**（発注は
   * 実弾になるため測れない）。errors.md の意味が一致するので選んだ**推測**である。
   * 成功させる方が危ない——本番で成立しない注文について、利用側が「成功する」という契約を
   * 学習してしまう。だから fail-closed に倒した（**v0.1.0 からの改訂**。改訂前は成功させていた）。
   *
   * **取消には使わない。** 公式は `stop_order`（"order suspended flag"）と
   * `stop_order_and_cancel`（"order **and cancel** suspended flag"）を書き分けており
   * （`rest-api.md:1696-1697`）、前者だけから取消の禁止は読めない。隣の
   * `70018`「Order and cancel on pair have been suspended.」が後者に対応するが、
   * **静的なペア表は `stop_order_and_cancel` の値を持たない**ので `70018` は置かない
   * （`docs/fidelity.md` の「ペア」節）。
   */
  PAIR_ORDER_SUSPENDED: 70017,
} as const;

/**
 * 封筒に出る error code の型。`ErrorCode` のメンバの値だけを受ける。
 *
 * error code の定義元をこのファイルに 1 つだけ保つための型。番号を別の場所へ書き写すと
 * 定義元が 2 つになり、片方だけ直した変更が型にもテストにも引っかからないまま
 * wire に出る値だけを変える。番号を持つ地図はこの型で締めて、`ErrorCode` に無い数値を
 * 書いたら typecheck が落ちるようにする（`src/routes/params.ts` の `QUERY_PARAM_CODES`）。
 */
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
