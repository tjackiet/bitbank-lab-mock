# bitbank-lab-mock 開発計画（プラン A 対応）

作成日: 2026-09-11（2026-09-14 に永続化の診断結果を 10 節として、2026-09-27 に R4 の実装を 16 節として、2026-09-30 に利用側の Plan A 向けの実験の口を 17 節として追記し、同日に要判断事項 17〜28 を決定し、その続き（REST の障害注入と stream の切断）を 18 節として追記）
対象: 「bitbank-lab-mock 要件メモ」の R1〜R4 と 5〜7 節
前提: 本計画は現行コード（`main` @ `0859aab`、テスト 45 件・`tsc --noEmit` 通過を確認済み）、bitbank 公式 `bitbank-api-docs`（rest-api.md / private-stream.md / errors.md）、および「bitbank-lab-mock 要件メモ」を突き合わせて作成した。

---

## 0. 結論（先に要点）

| 論点 | 結論 |
|---|---|
| R1 と R3 を一体で扱うか | **一体で扱う。** 注文レコード（`OrderRecord`）を単一の真実にする R3 の構造変更を先に入れ、その上に R1 の 2 エンドポイントを「レコードを整形して返すだけ」として実装する。R1 単体の小手先対応（`history` や取消済みリストから逆引き）は、`ordered_at` の誤り・`executed_amount` の欠落・取消済み注文の消失を引きずるため採らない |
| 着手順 | Phase 0（対応表の骨子・公式 doc 確認・CI 導入）→ Phase 1（R3 状態モデル）→ Phase 2（R1 照会 API）→ Phase 3（R2 control API）→ Phase 4（README 免責・対応表確定・v0.1.0 タグ）→ Phase 5（R4 private stream、11 月） |
| 期日の目安 | **10/23 までに v0.1.0（R1 + R2 + R3 の 3 値到達分）を出す**。週割りは 10/10 を狙って組み、2 週間の遅れを許容する。実装フェーズ最初の 1 週間（タスク 3.2）は現行モックでも成立する |
| 利用側との整合 | 注文状態の照合は `orders_info` を使うので R1 は一括照会が主。数量・価格はペアの桁数で固定小数に整形する（利用側は円・satoshi の整数で扱う）。経路 MCP → 利用側 → モックには bitbank-lab-mcp 側の接続先上書きが要る（本リポジトリ外の前提条件） |
| 既存テストへの影響 | 45 件中、書き換えが必要なのは約 20 件（engine/match 11 件のうち 8 件、engine/state 13 件のうち 5 件、routes 15 件のうち 7 件）。**削除するテストは無い。** アサーション対象を `state.openOrders` / `state.history` からビュー関数へ差し替えるのが主 |
| 対応表 | Phase 0 で `docs/fidelity.md` を作り、以後すべての PR で「対応表を更新したか」をチェック項目にする。Phase 4 で API 担当レビュー（60 分）向けに凍結 |

---

## 1. 現状の再確認（メモとの差分）

メモ 2 節の記述は概ね正確。コードを読んで確認した補足・訂正を挙げる。**★ は計画に影響するもの。**

### 1.1 メモの通りだった点

- `PaperState` は `balances` / `openOrders` / `history` の 3 つ。注文レコードは無い
- `applyFill()` は全量約定。`runTick()` は 1 分足の high/low 判定
- `formatOpenOrder` → `UNFILLED` 固定、`formatHistoryAsOrder` → `FULLY_FILLED` 固定で `ordered_at` に約定時刻、`formatCanceledOrder` → `CANCELED_UNFILLED` 固定
- `OrderStatus` 型は 5 値。`INACTIVE` / `REJECTED` は無い
- 注文 ID は `Date.now() * 1000 + counter`（`SessionStore.nextOrderId()`、**プロセス再起動でカウンタがリセットされる**）

### 1.2 メモに無かった点

- ★ **成行注文は `openOrders` を経由せず直接 `history` に入る**（`create-order.ts`）。注文 ID は採番されるので、R1 では成行も ID で引けなければならない（利用側は指値のみだが、モックの整合性として）
- ★ **すべてのルートが冒頭で `store.tick()` を呼び、テスト以外では bitbank public API に実際にアクセスする。** R2 で「価格を与えて tick を回す」を作っても、次の REST 呼び出しで実市場の足によって勝手に約定しうる。**R2 には「自動 tick を止めるモード」が必須**（3.3 節）
- ★ `trade_id` が `order_id` と同一値（`formatTrade`）。1 注文 1 約定の現状では衝突しないが、部分約定へ拡張すると破綻する。R3 で採番を分ける
- ★ **エラーコードの誤用がある。** 残高不足に `50008`（公式: Identity verification is not finished）を返しているが、公式の残高不足は `60001` Insufficient amount。`INVALID_AMOUNT: 30009` は公式では Missing asset、`INVALID_PRICE: 30013` は Missing side。利用側が拒否理由をコードで判別する可能性があるため、R1 と同時に是正し対応表に載せる
- `cancel_order` の応答に `canceled_at` が無い。公式では必須フィールド
- `user_cancelable` / `post_only` / `expire_at` を返していない。公式応答に存在するフィールド
- 取消対象が約定済み・取消済みの場合、現状は一律 `50009`（Order not found）。公式には `50026`（already canceled）/ `50027`（already executed）がある
- 認証ヘッダのチェックは無い（design.md 上 P1）。利用側が HMAC を付けて送っても通るので、プラン A ではこのままでよい
- 永続化は既定で `~/.bitbank-mock/sessions/default/state.json`。`version: 2` の Zod スキーマと v1→v2 マイグレーションがあるので、R3 は **v3 + マイグレーション**として実装する
- README は旧ロードマップ（ダッシュボード・WS public プロキシ・サンプル bot）を掲げており、メモ 4 節の非目標と矛盾する。移管時に書き換える（Phase 4）

### 1.3 公式ドキュメントの確認結果（R1 に直結）

rest-api.md（2026-09-11 取得）より。

| 用途 | メソッド・パス | パラメータ | 備考 |
|---|---|---|---|
| 単一注文の照会 | `GET /v1/user/spot/order` | query: `pair`（必須）, `order_id`（必須） | 発注 `POST /v1/user/spot/order` と同パス・別メソッド。メモの推測通り |
| 複数注文の一括照会 | `POST /v1/user/spot/orders_info` | body: `pair`, `order_ids: number[]` | 応答は `{ orders: [...] }`。存在しない ID は**エラーにならず単に含まれない**（3 か月以上前の注文に関する Caveat から。存在しない ID そのものの記述は無いので推測として対応表に記録） |
| 単一照会で見つからない場合 | 同上 | | Caveat に「3 か月以上前の注文は `50009`」とある。存在しない ID も `50009` と推測（対応表に記録） |

照会応答のフィールド（公式）: `order_id`, `pair`, `side`, `position_side?`, `type`, `start_amount`, `remaining_amount`, `executed_amount`, `price?`, `post_only?`, `user_cancelable`, `average_price`, `ordered_at`, `expire_at`, `triggered_at?`, `trigger_price?`, `status`。取消応答にはさらに `canceled_at`。

status の enum は照会で 7 値。**発注・取消の応答では `REJECTED` を除く 6 値**と書かれている（照会でのみ `REJECTED` が現れる）。

そのほか R1 に関係する公式仕様:

- `active_orders` は `count` / `from_id` / `end_id` / `since` / `end` を受ける（現状 `pair` のみ）
- `trade_history` は `order_id` / `since` / `end` / `order(asc|desc)` を受ける（現状 `pair` / `count` のみ）。利用側が注文単位で約定を突き合わせる際に `order_id` 絞り込みを使う可能性が高い
- レート制限は QUERY 10 回/秒、UPDATE 6 回/秒、超過時 HTTP 429（プラン A では実装しないが対応表に載せる）

private-stream.md より（R4 に直結）:

- 配信メッセージは `{ "message": { "method": "...", "params": [...] } }`
- 注文系は `spot_order_new`（新規）/ `spot_order`（更新）で、**どちらも注文の全フィールドを含むスナップショット**。約定は `spot_trade`、残高は `asset_update`
- シーケンス番号・順序保証の記述は無い（メモ通り）
- 接続には `GET /v1/user/subscribe` で `pubnub_channel` / `pubnub_token` を得る。トークン TTL 12 時間

---

## 2. 全体の進め方と順序

### 2.1 Phase 0 に含める基盤作業: GitHub Actions

現状 `.github/` が無く、テストと型検査はローカルの手動実行に頼っている。Phase 1 で既存テストの約半分を書き換えるため、その前に PR ごとの自動実行を入れる。姉妹リポジトリ bitbank-lab-cli の `.github/workflows/ci.yml` と `security.yml` をほぼそのまま流用する。

| ワークフロー | 内容 | 判断 |
|---|---|---|
| `ci.yml` | PR と main への push で `npm ci` → `tsc --noEmit` → `vitest run` | 必須。Phase 1 より前に入れる |
| `security.yml`（`npm audit --audit-level=high`） | 依存の脆弱性を high 以上でブロック。週 1 の定期実行付き | 入れる。依存が 3 つしか無いので落ちる要素が少なく、コストも低い |
| `security.yml`（gitleaks） | git 全履歴の秘密情報スキャン。バージョンと SHA256 を固定 | 入れる。このモックは API キーを扱わないが、移管先の bitbankinc では CLI と MCP が既にやっており、揃えておく |
| lint（biome） | 整形と静的解析 | 任意。入れるなら Phase 0 で `biome.json` を足し、`ci.yml` に `biome check src/ tests/` を加える |

CD（自動デプロイ・npm 公開・GitHub Release）は作らない。版の固定は git のタグで足りる。`.nvmrc` が無いので `ci.yml` に `node-version` を直書きするか、`.nvmrc` を追加する。**実装では `node-version: 24` を直書きした**（`package.json` の `engines` は Node 20 以上なので、ローカルが 20 系でも CI は 24 で通す）。

```
Phase 0  対応表の骨子 / 公式 doc との差分洗い出し / CI    9/15 週  （1〜2 日）
Phase 1  R3: 注文レコード中心の状態モデル（v3）         9/15〜9/26
Phase 2  R1: GET order / POST orders_info + 周辺整合   9/22〜10/3   （Phase 1 と一部並行）
Phase 3  R2: /_control/ 名前空間                       9/29〜10/8
Phase 4  README 免責 / 対応表凍結 / v0.1.0 タグ         10/6〜10/10
   ── 10/13 週: バッファ、結合確認 ──
Phase 5  R4: private stream                            11 月
移管     repository transfer / リネーム                 Phase 4 完了後、bitbankinc 側の準備が整い次第
```

Phase 1 を先にする理由は 0 節の通り。Phase 1 の途中で期日リスクが顕在化した場合の退避策は 8 節。

---

## 3. 設計

### 3.1 R3: 状態モデル（PaperState v3）

メモ 3 節 R3 の提案をそのまま採用し、細部を決める。

```ts
// src/engine/state.ts（v3）
type OrderStatus =
  | "INACTIVE" | "UNFILLED" | "PARTIALLY_FILLED" | "FULLY_FILLED"
  | "CANCELED_UNFILLED" | "CANCELED_PARTIALLY_FILLED" | "REJECTED";

type OrderRecord = {
  id: string;                  // 数値文字列。応答時に number 化（現行 toIdOut を踏襲）
  pair: string;
  side: "buy" | "sell";
  type: "limit" | "market";
  price: number | null;        // market は null
  startAmount: number;
  executedAmount: number;      // 不変量: 0 <= executed <= start
  executedNotional: number;    // Σ(price × amount)。average_price = notional / executed
  status: OrderStatus;
  orderedAt: string;           // 発注時刻（ordered_at の真の値）
  canceledAt: string | null;
  updatedAt: string;
};

type TradeRecord = {           // 旧 PaperHistoryEntry
  tradeId: string;
  orderId: string;
  pair: string;
  side: "buy" | "sell";
  type: "limit" | "market";
  amount: number;
  price: number;
  feeQuote: number;
  makerTaker: "maker" | "taker";
  executedAt: string;
};

type PaperState = {
  version: 3;
  createdAt: string;
  updatedAt: string;
  initialJpy: number;
  lastTickAt: string;
  balances: Record<string, number>;
  orders: OrderRecord[];       // 単一の真実。生成順
  trades: TradeRecord[];       // 旧 history。orderId で orders に紐づく
  nextOrderSeq: number;        // 採番カウンタ（永続化して再起動で戻らない）
  nextTradeSeq: number;
};
```

**ビュー関数**（`openOrders` の代替）:

```ts
export const isActive = (o) => o.status === "UNFILLED" || o.status === "PARTIALLY_FILLED";
export const activeOrders = (s) => s.orders.filter(isActive);
export const remainingOf = (o) => o.startAmount - o.executedAmount;
```

`computeLocked()` / `availableOf()` は `activeOrders(s)` と `remainingOf(o)` で計算するように変えるだけで、発想は現状のまま活かす。

**状態遷移を 1 か所に集める**（`src/engine/transitions.ts`、新設）:

```ts
placeOrder(state, input, now, marketPrice?, feeRate?) → { state, order, trade? }
   // limit は UNFILLED で止まる。market は呼び出し側（ルート）が SessionStore.getLatestPrice() で
   // 解決した価格を marketPrice に渡し、内部で fillOrder(remaining, marketPrice) まで進める。
   // market で marketPrice 未指定なら Result.error（価格が取れないときは 70001 を返す現行挙動を踏襲）
   // 戻り値の形は全遷移で共通: { state, order, trade? }（TransitionOk）。state は次の永続化対象。
   // **touchedAssets は #34 で削除済み**（4 生成点・0 読み手の dead code。11.1 に記録がある）。
   // asset_update の発火情報をどこから取るかは 14.2 の要判断事項 13 で、まだ決めていない
fillOrder(state, orderId, price, amount, at, feeRate?) → { state, order, trade }
   // amount < remaining なら PARTIALLY_FILLED、== remaining なら FULLY_FILLED
   // 呼び出し側が amount = remaining を渡せば全約定になる。**「常に remaining」ではない**——
   // POST /_control/orders/:order_id/fill は部分約定量も受け付ける（src/routes/control.ts）
cancelOrder(state, orderId, at)           → { state, order }
   // UNFILLED → CANCELED_UNFILLED、PARTIALLY_FILLED → CANCELED_PARTIALLY_FILLED
   // 終端状態なら Result.error（呼び出し側が 50026 / 50027 に変換）
rejectOrder(state, orderId, at)           → REJECTED（プラン A では到達させない。関数だけ用意）
   // → 2026-09-30 に 17 節で、/_control/ から到達させることにした（PR A で
   //   POST /_control/orders/:order_id/reject として入れた）
```

**`feeRate` は `placeOrder` / `fillOrder` の末尾にある省略可能な引数**で、既定は
`DEFAULT_TAKER_FEE_RATE`（0.0012）。拘束額と手数料の計算に使う。渡すのは `SessionStore.feeRate` を
持つ呼び出し側で、`src/routes/create-order.ts` と `src/routes/control.ts` の fill が明示的に渡し、
それ以外は既定のまま呼ぶ。**拘束に使う料率と引き落としに使う料率が食い違わない**のはこの形による
（`SessionStore.feeRate` は `readonly` で構築時に 1 度だけ決まる。14.1 の (1)）。`cancelOrder` と
`rejectOrder` は残高を動かさないので受け取らない。

`applyFill()` / `runTick()` は内部で `fillOrder()` を呼ぶ薄いラッパにする。`runTick()` の 1 分足判定ロジック自体は変えない。

**不変量**（テストで検証し、`docs/fidelity.md` にも書く）:

1. `0 <= executedAmount <= startAmount`
2. `status ∈ {INACTIVE, UNFILLED}` ⇔ `executedAmount == 0` かつ非終端（`INACTIVE` はプラン A では到達しないが、7 値モデルの不変量としてはここに含める）
3. `status ∈ {FULLY_FILLED}` ⇔ `executedAmount == startAmount`
4. 終端状態（`FULLY_FILLED` / `CANCELED_*` / `REJECTED`）に達したレコードは以後いかなる遷移でも変化しない
5. `trades` の `orderId` ごとの `amount` 合計 == その注文の `executedAmount`
6. 資産ごとの `locked` == アクティブ注文の未約定分から計算した値（現行 `computeLocked` と同義）

**永続化**: `PaperStateSchemaV3` を追加し、`persist.ts` の `migrateToLatest` に v2→v3 を足す。v2 の `openOrders` は `UNFILLED` のレコードに、`history` は `FULLY_FILLED` のレコード + `TradeRecord` に変換する（v2 には発注時刻が無いので `orderedAt = filledAt` とし、対応表に「移行データは `ordered_at` が不正確」と記録）。

移行時の ID 衝突を防ぐ規則:

- 移行した `TradeRecord` の `tradeId` は、`history` の並び順に `1, 2, ...` を振り直す（v2 の `id` は注文 ID なので trade ID には使わない）。`nextTradeSeq` はその最大値 + 1（`history` が空なら `1`）
- `nextOrderSeq` は、移行した注文 ID のうち数値として解釈できるものの最大値 + 1 とする（該当が無ければ `1`）。旧形式の巨大な ID（`Date.now() * 1000 + counter`）が残る場合はそこから続きを振るので、単調増加は保たれる（桁が大きいままになる点は対応表に記録）
- `nextOrderSeq` / `nextTradeSeq` は状態に永続化し、再起動後もそこから続ける
- テスト: v2 ファイルを読み込んで再起動し、以後の発注・約定の ID が既存レコードと衝突せず単調増加することを `tests/engine/state.test.ts` で確認する。`openOrders` / `history` がともに空の v2 からの移行も同じテストで扱う

**注文 ID 採番（決定済み、2026-09-11）**: `Date.now() * 1000 + counter` をやめ、状態に持つ連番（`nextOrderSeq`、初期値 `1`）にする。理由は (a) 再起動で重複しない、(b) シナリオスクリプトで ID を予測でき、再現性が上がる、(c) 本物も単調増加の整数である点は同じ。桁数が本物と異なる点は対応表へ。

### 3.2 R1: 注文照会エンドポイント

| 追加 | 内容 |
|---|---|
| `POST /v1/user/spot/orders_info`（主） | body `pair`, `order_ids[]`。見つかったものだけ `{ orders: [...] }` で返す。0 件でも `success: 1`。利用側の照合が使う経路 |
| `GET /v1/user/spot/order`（従） | query `pair`, `order_id`。`orders` から検索し `formatOrder()` で整形。見つからない、または `pair` 不一致なら `50009` |

同時に行う整合作業（すべて `OrderRecord` があれば自然にできるもの）:

- `format.ts` を `formatOrder(o: OrderRecord)` 1 本に統合。`status` / `executed_amount` / `remaining_amount` / `average_price` / `ordered_at` をレコードから出す。`canceled_at`（取消時のみ）、`user_cancelable`（アクティブなら true）、`post_only: false`、`expire_at: null` を追加
- **数量・価格の文字列化をペアの桁数で固定小数にする**（例: btc_jpy の数量は 4 桁、価格は整数）。利用側は円と satoshi の整数で扱うため、倍精度の丸め誤差が文字列に漏れると解析に失敗する。桁数の出典は公式 `pairs.md` / `GET /spot/pairs` とし、プラン A では btc_jpy を定数で持つ
- `active_orders` を `activeOrders(state)` のビューに切り替え（`PARTIALLY_FILLED` も含む）。`count` / `since` / `end` / `from_id` / `end_id` を受け付ける。発注応答を取りこぼした利用側が自分の注文を探す経路になるため、`since` / `from_id` は実際に絞り込みを効かせる
- `trade_history` に `order_id` / `since` / `end` / `order` を追加
- `cancel_order` / `cancel_orders` の終端状態への応答を `50026` / `50027` に変更
- エラーコードの是正: 残高不足 `60001`、amount 欠落 `30001`、price 欠落 `30012`、side 欠落 `30013`、type 欠落 `30015`、order_id 欠落 `30006`

**R1 の受入条件と確認方法**

| 受入条件 | テスト |
|---|---|
| 生成したすべての注文が ID で引ける | 指値 → 約定 / 指値 → 取消 / 成行 の 3 経路で `GET order` が `success: 1` |
| `status` 等 5 フィールドが正しい | 各経路で `status`, `executed_amount`, `remaining_amount`, `average_price`, `ordered_at` を検証。特に `ordered_at` が発注時刻で、約定後も変わらないこと |
| 存在しない ID の挙動 | `GET order` → `50009`、`orders_info` → 含まれず `success: 1` |
| `pair` 不一致 | `GET order` → `50009` |
| 数値の整形 | 発注量 `0.1 + 0.2` 相当の演算を経ても `executed_amount` / `remaining_amount` がペアの桁数に収まった文字列であること |
| 注文状態の照合の模擬 | 発注 → 約定 → `orders_info` を 2 回引いて同一スナップショットが返ること。プラン A の全量約定では `executed_amount × average_price` が約定代金と厳密に一致すること。部分約定を含む場合は下記の丸め規則の許容差内であること |

`average_price` の丸め規則: 内部では `executedNotional`（倍精度）を真値として保持し、`average_price = executedNotional / executedAmount` をペアの価格桁数（btc_jpy なら整数）に四捨五入して文字列化する。`executedAmount == 0`（`UNFILLED` / `CANCELED_UNFILLED` / `REJECTED`）のときは除算せず `"0"` を返す（現行 `formatOpenOrder` と同じ。発注 → `GET order` の初回応答で検証する）。複数回の約定で平均が価格単位に乗らない場合（例: 100 と 101 で 0.5 ずつ約定 → 100.5）は丸めが入るため、`executed_amount × average_price` と約定代金の差は `executed_amount × 価格単位 × 0.5` 以下を許容する。利用側が累計をこの積で再計算する際に同じ誤差が乗ることは対応表に記録する。内部演算を円・satoshi の整数に切り替えるかはプラン B（部分約定を実際に起こす段階）で判断する

数量の桁の検査: 発注（`POST order`）と control の `fill` は、`amount` がペアの数量桁数（btc_jpy なら 4 桁）に**許容差の内側で**収まらない値を受け付けず、公式の `40001`（発注。**2026-09-21 の改訂より前は `60004`**。`docs/fidelity.md` の「エラーコード」節）または 400（control）で拒否する。**これは量を格子へ載せる保証ではない。** `fitsDigits()` はスケール後の整数からのずれを `DIGIT_FIT_EPS`（`1e-8`）未満まで塵として通すだけなので、`0.1 + 0.2` のような値は `0.30000000000000004` のまま `executedAmount` に入り、`formatAmount()` の `toFixed` が文字列化のときに `"0.3000"` へ丸める（`docs/fidelity.md` の「不変量をどこで担保するか」）。上記の `average_price` の許容差が価格の丸めだけに由来する、という整理は変わらない——数量側の丸めは倍精度の塵の幅に収まり、桁の外へは出ないからである。量を本当に量子化するのは Phase 2（整数最小単位への移行）の話

### 3.3 R2: 約定を意図的に起こす仕組み（`/_control/`）

**有効化**: 環境変数 `BITBANK_MOCK_CONTROL=1` のときのみルートを登録する（既定は無効。無効時は 404）。

**アクセス境界**: 現状サーバは `0.0.0.0` で listen しているため、control を有効にすると同一ネットワークの誰でも状態を読み書きできる。次の 2 段で守る。

- control 有効時は listen ホストの既定を `127.0.0.1` にする（`BITBANK_MOCK_HOST` で明示した場合のみ他のアドレスに bind できる）
- `/_control/` の各ルートは、接続元がループバックでない場合は `X-Control-Token` ヘッダが `BITBANK_MOCK_CONTROL_TOKEN` と一致しない限り 403 で拒否する。トークン未設定なら非ループバックからは常に 403
- テスト: ループバックからの成功、非ループバック + トークン無しの 403、非ループバック + 正しいトークンの成功を `tests/routes/control.test.ts` に含める（Fastify の `inject` で `remoteAddress` を差し替える）

**自動 tick の停止**: `BITBANK_MOCK_FILL_MODE=market | manual`。`manual` では `store.tick()` が実市場の足を取りに行かず、`/_control/` からの操作でのみ状態が動く。**既定は control の有効・無効に連動させる（決定済み、2026-09-11）**: `BITBANK_MOCK_CONTROL` 未設定なら `market`（現行挙動）、設定時は `manual`。control を使いながら市場連動で試したい場合だけ `FILL_MODE=market` を明示する。設定忘れでシナリオの再現性が壊れないようにするため。

**エンドポイント**（すべて JSON、bitbank 封筒ではなく素の JSON で返す。bitbank API と誤解されないため）:

| メソッド | パス | 入力 | 動作 |
|---|---|---|---|
| POST | `/_control/orders/:order_id/fill` | `{ price?, amount? }` | 指定注文を約定させる。`price` 省略時は指値価格、`amount` 省略時は残量全部。`amount < remaining` なら `PARTIALLY_FILLED`。プラン A でも受け付け、遷移・残高・約定記録・REST 応答（`status` / `executed_amount` / `remaining_amount` / `average_price`）をテストで検証する（4.3 節）。実験環境として部分約定を「意図的に起こす」運用はプラン B からだが、モックの機能として未検証のまま出さない。入力検証は下記 |
| POST | `/_control/tick` | `{ pair, price }` または `{ pair, candle: { open, high, low, close, timestamp? } }` | 与えた価格を 1 本の足として `runTick()` を回す。`price` だけなら `high = low = price`。複数注文をまとめて動かす用 |
| POST | `/_control/reset` | `{ initialJpy?, balances? }` | 状態を初期化。シナリオ冒頭で使う |
| GET | `/_control/state` | | `PaperState` をそのまま返す（デバッグ用） |

`fill` は 3.1 の `fillOrder()` を直接呼ぶ。`tick` は `runTick()` に人工の足を渡す。どちらも既存の遷移関数を通るので、REST 経路と control 経路で状態の整合性が崩れない。

`fill` の入力検証（不変量 1 を control 経路から壊させないため）:

| 条件 | 応答 |
|---|---|
| 注文が存在しない | 404 `{ error: "ORDER_NOT_FOUND" }` |
| 注文が終端状態 | 409 `{ error: "ORDER_NOT_ACTIVE", status }` |
| `amount` が有限の正数でない、または `amount > remaining` | 400 `{ error: "INVALID_AMOUNT", remaining }` |
| `price` が有限の正数でない | 400 `{ error: "INVALID_PRICE" }` |

検証は `fillOrder()` を呼ぶ前に行い、拒否時は注文・残高・約定記録のいずれも変更しない。`fillOrder()` 自身も同じ条件で `Result.error` を返す二重防御にする（不変量テストの対象）。`tick` の `candle` は 4 値がすべて有限の数値で、`0 < low <= open <= high` かつ `low <= close <= high` を満たすことを検証する（`Infinity` を通すと全売り注文が約定するため、`> 0` だけでは足りない）。`price` 指定の場合は同じ検証を `high = low = open = close = price` に適用する。`runTick()` 側も同じ検証で `Result.error` を返す二重防御にする。

**R2 の受入条件と確認方法**

- `tests/routes/control.test.ts`: `BITBANK_MOCK_CONTROL` 未設定で 404、設定時に各エンドポイントが動く
- `tests/scenarios/plan-a.test.ts`（新設）: 「発注 → `GET order` で UNFILLED → `/_control/orders/:id/fill` → `GET order` で FULLY_FILLED、`assets` の locked が減り onhand が変わる」を `fetchCandles` スタブ無しで通す。これが「実市場に依存せずシナリオをスクリプトで再現できる」の直接の証拠
- `examples/scenario-plan-a.sh`（curl 数行）: 動作確認用のデモ手順。テストと同じ流れ

### 3.4 R4: private stream（11 月）

設計だけ先に決めておく。**2026-09-27 に実装した。** 下で未決としていた点の決定と、実装で派生して決めた点は 16 節にある。

- **トランスポート（決定済み、2026-09-11）**: PubNub を模倣せず、素の WebSocket（`@fastify/websocket`）を `ws://host/_stream/private` で提供する。`GET /v1/user/subscribe` は公式通りの形で `pubnub_channel` / `pubnub_token` を返し、値はダミー。README に「PubNub SDK ではなく WebSocket で受ける」と明記する。理由: PubNub のプロトコル互換を作る労力に対して、利用側で必要なのはメッセージ本体の互換だけ
- **メッセージ**: 公式と同じ `{ message: { method, params } }`。**`params` の形はメソッドで揃っていない**——4 つは配列だが、**`spot_order_invalidation` だけ公式の応答例が `params` をオブジェクトにしている**（`private-stream.md:234-236` / `private-stream_JP.md:235-237`。中の `order_id` が配列）。しかも同じ節のフィールド表は `order_id` を**単数の数値**と書いており、表と例が食い違う。詳しくは `docs/fidelity.md` の「private stream の `spot_order_invalidation`」節。イベントごとに整形関数を分ける
  - `spot_order_new`（発注時）/ `spot_order`（更新時）: 注文のスナップショット。**公式が「内容は `spot_order_new` と同一」と明記している**ので（`private-stream.md:176` / `private-stream_JP.md:177`）、**整形関数を 2 本作る必要は無い**
  - **その注文ペイロードは REST のスーパーセットで、`formatOrder()` のままでは足りない。** 公式のフィールド表（`private-stream.md:115-136` / `private-stream_JP.md:116-137`）は REST の Fetch order information の応答表（`rest-api.md:292-310`）に対して **`executed_at` と `is_just_triggered`** を追加で持ち、`formatOrder()` はどちらも持たない。**共通部分は共有できるが、そのままでは足りない**。どう分けるかは 14.1 の (2) に調査結果だけ置いてあり、**決めていない**（→ 16.2 で `formatOrder()` を土台に 2 つを足す形に決定）
  - `spot_trade`: `params: [formatTrade(trade)]`。**REST の `trade_history` と同じ形**（応答表どうしを突き合わせて確認した。14.1 の (2)）
  - `asset_update`: 変化した資産だけを載せる。**キーの命名は公式内で矛盾しており未確定**——フィールド表は snake_case、JSON 応答例は camelCase である（英日とも同じ構造）。**どちらを採るかは R4 実装時に決める**ので、整形関数を分けるかどうかもいま決めない（→ 16.2 で既定 camelCase・env で snake_case に切替、と決定）（`docs/fidelity.md` の「private stream の `asset_update` のキー」節）
- **発火点**: `TransitionOk`（`{ state, order, trade? }`）から `order` と `trade` は取れる。**`asset_update` の発火情報は現在どこからも取れない**——`touchedAssets` は #34 で削除済みである（11.1）。また**「REST 経路も control 経路も同じ遷移関数を通るため発火漏れが無い」とは言えない**: `POST /_control/reset` と `POST /_control/clock` は遷移関数を通らず、`SessionStore.tick()` は `commit()` を経由せず、一括取消は n 件の結果を畳んで `commit()` を 1 回だけ呼ぶ（経路の一覧は 14.1 の (3)）。**扱いは 14.2 の要判断事項 13 へ送る**（→ 16.1 で決定。状態の差から作る）
- **障害注入の余地**: emit と WebSocket 送信の間に `DeliveryPolicy` インタフェース（`deliver(events) => events`）を 1 つ挟む。プラン A では恒等写像。プラン B で重複・順序入替・欠落を差し込む（→ 2026-09-30 に 17 節で Plan A へ前倒しした。仕組みは要判断事項 18）
- **テスト**: 範囲内のメソッドは **5 つ**（`asset_update` / `spot_order_new` / `spot_order` / `spot_order_invalidation` / `spot_trade`）。`ws` クライアントで接続し、注文を 2 本発注し、1 本を `/_control/` で約定、もう 1 本を取消する流れで `spot_order_new`（2 回）/ `spot_order`（FULLY_FILLED と CANCELED_UNFILLED）/ `spot_trade` / `asset_update` の形を検証する。**`asset_update` のキーの検証は命名が決まってから書く**（上記。16.2 で決めたので両方の綴りを検証している）。**`spot_order_invalidation` は受入条件に入れない**——公式の発生条件（マッチングエンジン内の資産不足）が本モックでは構造的に起こり得ないため（`docs/fidelity.md` の「private stream の `spot_order_invalidation`」節）

---

## 4. 既存テスト（45 件）への影響と移行手順

### 4.1 影響の内訳

| ファイル | 件数 | 影響 | 内容 |
|---|---|---|---|
| `tests/engine/candles.test.ts` | 6 | なし | |
| `tests/routes/envelope.test.ts` | 2 | なし | |
| `tests/engine/match.test.ts` | 11 | **8 件書き換え** | `applyFill` の引数（`OpenOrder` → `orderId`）、`r.state.openOrders` / `r.state.history` のアサーションを `activeOrders(state)` / `state.trades` へ |
| `tests/engine/state.test.ts` | 13 | **5 件書き換え** | fresh state の形（v3）、`computeLocked` の入力（`orders`）、persist の round trip、v1→v2 移行テストに v2→v3 を追加 |
| `tests/routes/create-order.test.ts` | 5 | 2 件 | `store.state().openOrders` / `history` の参照 |
| `tests/routes/cancel-order.test.ts` | 3 | 3 件 | 同上 + `buildOrder` の形 |
| `tests/routes/active-orders.test.ts` | 2 | 1 件 | `buildState({ openOrders })` → `orders` |
| `tests/routes/trade-history.test.ts` | 2 | 1 件 | `history` → `trades` |
| `tests/routes/assets.test.ts` | 1 | 0〜1 件 | `buildState({ openOrders })` を使っていれば |

**削除するテストは無い。** 期待値（金額・件数・ステータス）はすべてそのまま成立する。

### 4.2 移行手順（Phase 1 を 3 コミットに分ける）

1. **ヘルパ先行**: `tests/engine/helpers.ts` の `buildState` / `buildOrder` を v3 の形にし、`buildOrder` は `OrderRecord`（`status: "UNFILLED"`, `executedAmount: 0`）を返すようにする。ここで一度全テストを壊す
2. **モデル + 遷移関数**: `state.ts` v3、`transitions.ts`、`persist.ts` の v2→v3。`match.ts` をラッパ化。engine テスト 30 件を通す
3. **ルート追随**: `create-order` / `cancel-order` / `active-orders` / `trade-history` / `format.ts` をレコード経由に。routes テスト 15 件を通す

各コミットで `npm test` と `npm run typecheck` を通す。1 の直後だけ赤でよい（同一 PR 内）。

### 4.3 新規テスト（要件ごと）

| 要件 | ファイル | 主な項目 |
|---|---|---|
| R3 | `tests/engine/transitions.test.ts` | 各遷移の前後状態、終端状態からの遷移拒否、部分約定時の `PARTIALLY_FILLED` と `average_price`、3.1 の不変量 1〜6 |
| R3 | `tests/engine/invariants.test.ts` | 発注・約定・取消をランダム順で数百回適用し、各ステップで不変量 1〜6 を検証（`fast-check` 導入を推奨。Lean 側の証明対象と同じ性質をテスト側でも押さえる） |
| R3 | `tests/engine/state.test.ts` | v2→v3 移行: `openOrders` → `UNFILLED`、`history` → `FULLY_FILLED` + `trades` |
| R1 | `tests/routes/order-info.test.ts` | 3.2 の表 |
| R1 | 既存 routes テストへ追加 | `cancel_order` の `50026` / `50027`、`canceled_at`、`ordered_at` が発注時刻、エラーコード是正 |
| R2 | `tests/routes/control.test.ts` / `tests/scenarios/plan-a.test.ts` | 3.3 節。`fill` は全量に加えて `amount < remaining` の部分約定も 1 ケース通し、`GET order` の `PARTIALLY_FILLED` / `executed_amount` / `remaining_amount` / `average_price` と `assets` の残高を検証する |
| R4 | `tests/stream/events.test.ts` / `tests/stream/hub.test.ts` / `tests/routes/private-stream.test.ts` / `tests/routes/subscribe.test.ts` / `tests/scenarios/private-stream.test.ts` | 3.4 節・16.3（当初は `tests/stream/private.test.ts` 1 本の予定だった） |

---

## 5. 対応表（`docs/fidelity.md`）の書き起こしタイミング

- **Phase 0（着手初日）に骨子を作る。** 列は「項目 / モックの挙動 / 根拠（公式 doc の節・引用） / 本物との差異 / 推測かどうか / 影響（利用側への含意）」。メモ 5 節の 7 行に加え、1.2〜1.3 節で見つかった以下をシードとして入れる
  - 存在しない `order_id` への `GET order` の応答（`50009` と推測。doc は 3 か月以上前の注文についてのみ明記）
  - `orders_info` で存在しない ID を含まない挙動（推測）
  - エラーコード誤用の是正（`50008` → `60001` など）と、それでも網羅していないコード
  - 取消済み／約定済み注文への取消応答（`50026` / `50027`）
  - `trade_id` の採番、注文 ID の桁数
  - `maker_taker` が常に `maker`（指値）なのに手数料は単一の料率（既定 0.12%）で計算している不整合。**括弧内の「要確認」は 2026-09-17 に実測して閉じた**（`GET https://api.bitbank.cc/v1/spot/pairs`、認証不要）。通貨ペアごと・メイカー／テイカー別で異なるのは事実で、さらに **maker は 61 ペアが `-0.0002`（リベート）**、**`btc_jpy` だけ taker `0.001` / maker `0`** だった。指値ではモックが引く側、実 API は受け取る側で**符号が逆になる**。数値と留保（キャンペーンで変動する）は `docs/fidelity.md` の「手数料」節に記録した。**挙動は変えていない**（下の決定 3 のまま）
  - `expire_at: null` / `post_only: false` / `user_cancelable` 固定値
  - v2→v3 移行データの `ordered_at` が約定時刻である点
  - `/_control/` は bitbank に存在しない（当然だが、利用側の仕様に control の存在が漏れないよう明記）
  - private stream を PubNub でなく WebSocket で提供する点（R4）
  - 拘束額（`locked_amount`）に手数料を含めている点。手数料を含めない拘束額の見積もりとは食い違う。**「要確認」は 2026-09-17 の実測で閉じた**——実 API も手数料を含み（taker 料率）、モックの向きが正しいと確定した。あわせて残高表示が**切り捨て**であることも分かり、モックを四捨五入から切り捨てへ直した。詳細は `docs/fidelity.md`
  - 数量・価格の桁数（btc_jpy の数量 4 桁・価格整数）の出典
  - 執行セマンティクスに関する 6 点の行。注文訂正 API が無いこと、PubNub の順序非保証、`INACTIVE` は逆指値のトリガー待ちでモックでは到達しないこと、レート制限をモックが持たないこと、`CANCELED_PARTIALLY_FILLED` で `executed_amount` が残ること、成行に価格上限指定が無いこと
- **各 PR で更新する。** PR テンプレート（`.github/pull_request_template.md`、新設）に「公式 doc に無い挙動を推測で決めた場合、`docs/fidelity.md` に追記したか」のチェックボックスを置く
- **Phase 4（10/6 週）で凍結し、API 担当の 60 分レビューにかける。** レビュー結果は同ファイルに「確認済み／要修正」列として反映。外へ出すのは Phase 4 時点の版

---

## 6. スケジュール（目安）

2026-09-11 時点。期日は厳密ではないので、以下は「何をどの順で終えるか」の目安として置く。押さえるべき点は 2 つだけになる。

- **10/23 までに v0.1.0（R1 + R2 + R3 の 3 値到達分）を出す。** 10/01〜10/23 を実験環境の準備期間として見込む
- **10/28 からの実装フェーズ最初の 1 週間（タスク 3.2）は現行のモックでも成立する**（分割回避シナリオは約定を要しない）。R2 が遅れてもここは止まらない

以下は 10/10 に v0.1.0 を切る前提の週割り。2 週間遅れても 10/23 に間に合う。

| 週 | 作業 | 完了条件 |
|---|---|---|
| 9/15〜9/19 | Phase 0: `docs/fidelity.md` 骨子、PR テンプレート、GitHub Actions（CI / Security Audit）。Phase 1 開始: ヘルパ・状態モデル v3・遷移関数・不変量テスト | engine テスト緑 |
| 9/22〜9/26 | Phase 1 完了: ルート追随、v2→v3 移行。Phase 2 開始: `GET order` / `orders_info` | 45 件 + 新規が緑。`GET order` で約定済み・取消済みが引ける |
| 9/29〜10/3 | Phase 2 完了: エラーコード是正、`canceled_at`、`active_orders` / `trade_history` パラメータ。Phase 3 開始: `/_control/` と `FILL_MODE=manual` | シナリオテスト `plan-a.test.ts` 緑 |
| 10/6〜10/10 | Phase 3 完了、README 免責・棲み分け、対応表凍結、**v0.1.0 タグ**（`examples/scenario-plan-a.sh` 付き） | curl だけで「発注 → 約定 → 残高減」を再現できる |
| 10/13〜10/17 | バッファ。結合で出た指摘の反映。API 担当レビュー | |
| 10/20〜 | R4 設計レビュー、移管準備 | |
| 11 月 | Phase 5: R4 private stream | |

**工数感**: Phase 1 が最大で 4〜5 人日、Phase 2 が 2〜3 人日、Phase 3 が 2 人日、Phase 4 が 1〜2 人日。1 人で 10 人日前後、4 週間に対して余裕はあるが、Phase 1 の設計判断（3.1 節）を最初の 2 日で確定させることが鍵。

---

## 7. 移管に伴う作業（Phase 4 で準備、transfer は bitbankinc 側の準備後）

- `package.json` の `name` / `repository` / `description` を `bitbank-lab-mock` に。`bitbank-mock-api` の旧名は README に 1 行残す
- README を全面書き換え。構成: 何であるか（注文の状態を持つ挙動確認用モック）／**免責**（公開ドキュメント準拠の近似であり bitbank 公式のテスト環境ではない、動作保証はしない、`docs/fidelity.md` への導線）／`mock-bitbankcc` との棲み分け（あちらは SDK テスト用の静的スタブ）／起動方法と環境変数（`BITBANK_MOCK_CONTROL`, `BITBANK_MOCK_FILL_MODE`, `BITBANK_MOCK_STATE_PATH`）／`/_control/` の説明／非目標
- `docs/design.md` は旧 MVP 設計として残すが、冒頭に「プラン A の計画は `plan-lab-mock.md`、挙動の根拠は `fidelity.md`」と注記。ダッシュボード等の記述は「対象外」と明示
- LICENSE は MIT のまま（transfer 後も author 表記を維持するか bitbankinc 側と確認）
- transfer 後、`tjackiet/bitbank-mock-api` は GitHub のリダイレクトに任せる

---

## 8. リスクと退避策

| リスク | 兆候 | 対応 |
|---|---|---|
| Phase 1 が 9/26 を越える | 9/24 時点で routes テストが赤のまま | **R1 最小版に切り替える**: v3 モデルは入れず、`history` と新設の `canceledOrders[]` から `GET order` を組み立てる。`ordered_at` の誤りは対応表に明記する。R3 は 11 月へ。この場合 R2 の `fill` は現行 `applyFill` を直接呼ぶ |
| 実市場の足で勝手に約定してシナリオが崩れる | 結合確認で再現性が無いと報告 | control 有効時は `FILL_MODE=manual` が既定（3.3 節、決定済み）。残るのは明示的に `market` を指定した場合のみ |
| 公式 doc に無い挙動を推測で決めた箇所が仕様に漏れる | | 対応表の「推測」列と PR テンプレのチェックで機械的に拾う。API 担当レビューを 10/13 週に固定 |
| bitbankinc への transfer が遅れる | | コードは `tjackiet` 配下で v0.1.0 を切れる。README の免責は transfer 前から入れておく |
| **bitbank-lab-mcp が接続先を差し替えられない**（本リポジトリ外の前提条件） | MCP → 利用側 → モックの経路が組めない | MCP のメンテナが本計画の依頼者本人のため、MCP 側で base URL の上書き手段（環境変数）を足す。急ぎではなく、当面は利用側のテストから直接モックを叩く形で進められる |
| `orders_info` に存在しない ID が含まれない挙動を利用側が想定していない | 照合で snapshot が届かず、利用側が対象を stale にして fail-closed し続ける | 対応表の該当行を事前に共有し、利用側で「N 回引いても現れない ID は取引所に存在しない」と扱う規則を入れてもらう |

---

## 9. 要判断事項（2026-09-11 にすべて決定済み）

1. ~~`BITBANK_MOCK_CONTROL=1` のときの `FILL_MODE` 既定を `manual` にするか~~ → **決定: `manual` を既定にする**（2026-09-11、3.3 節に反映済み）
2. ~~注文 ID を連番にするか~~ → **決定: 単純な連番**（2026-09-11、3.1 節）。桁数が本物と異なる点は対応表に記録
3. ~~指値約定の手数料をどうするか~~ → **決定: プラン A はテイカー 0.12% 固定を維持し、対応表に載せる**（2026-09-11）。プラン A の累積約定代金に手数料は乗らず、利用側が `assets` を読まない限り影響しない。プラン B で `loss_limit` を有効にすると「手数料を損失に含める」既定値が効くので、その時点で `GET /spot/pairs` の maker/taker 料率を取得する方式に切り替える候補（bitbank-lab-cli の paper エンジンに 24 時間キャッシュ付きの実装があり移植可能）
4. ~~`fast-check` の導入可否~~ → **決定: 導入する**（2026-09-11、4.3 節の `invariants.test.ts`）
5. ~~R4 のトランスポートを素の WebSocket でよいか~~ → **決定: 素の WebSocket で提供する**（2026-09-11、3.4 節）。利用側の接続層を差し替え可能にしてもらう点だけ利用側に伝える
6. ~~bitbank-lab-mcp の接続先上書きを誰がいつ入れるか~~ → **決定: MCP のメンテナ（本計画の依頼者本人）が MCP 側で対応する**（2026-09-11）。本リポジトリからは環境変数名の提案（`BITBANK_API_BASE_URL`）だけ出す
7. ~~参照している外部仕様の最新版を追うか~~ → **決定: 追わない**（2026-09-11）。対応表の「根拠」列は bitbank 公式 doc だけを出典にするので、外部仕様の版ズレは本計画の技術判断に影響しない

---

## 10. v0.1.0 以後の改訂: 永続化の残件（2026-09-14）

2026-09-14 に、状態ファイルの書き込みが並行実行と再起動に耐えるかを診断した。結果は「契約は守られているが、宣言と実装の隙間が 3 つ残る」だった。本節は残件を改訂として出す順序と、最大の論点（persist に失敗したときの扱い）の決定を固定する。**Plan A は凍結済み**（`docs/fidelity.md` 冒頭）なので、以下はすべて v0.1.0 からの改訂として記録する。

### 10.1 診断で確かめたこと（根拠として残す）

| 観点 | 結果 |
|---|---|
| 書き込みの直列化 | **違反なし。** 実ファイルパスへ 30 本同時発注 × 20 試行、発注・取消・部分約定を混ぜた同時実行 × 20 試行、`replace()` + `persist()` を乱数で並べた 200 試行のいずれも、メモリとファイルが一致した。回帰チェックは `tests/store/session.test.ts` に 2 本あり、`SessionStore.persist()` の直列化を外すと落ちることを確認済み |
| 壊れた状態ファイル | **fail-closed。** 不正な JSON・空・空白のみ・途中で切れた・スキーマ違反・配列・`null` の 7 形すべてで起動せず、ファイルも残る。黙って初期状態へ戻す経路は無い |
| 移行の冪等性 | **変換は冪等。** 重複 id・ゼロ埋め id・巨大 id・安全整数の上限を含む 7 入力で確認。`startAmount == 0` だけは「移行時 warn → 書き戻し後 fail-closed」という非対称があるが、これは対応表に記載済みの既決事項 |
| 単一書き込みの原子性 | 一時ファイルを `wx` で作り `fsync` して `rename`、失敗時は自分が作った分だけ消す。**ディレクトリの `fsync` だけが無い**（PR 1） |
| 書き込み失敗の扱い | **成功応答を返した注文が再起動で消える。** 状態ファイルのパスをディレクトリにして `rename` を `EISDIR` で落とし、`success: 1` + `order_id: 1` が返ったあと再起動で注文が消えることを実測（PR 2 / PR 3） |
| 多重起動 | **ロック無し。** 同じ状態ファイルを指す 2 プロセスが同じ order id 1〜5 を払い出し、片方の 5 本が丸ごと消えることを実測（PR 4） |
| パス解決 | `BITBANK_MOCK_HOME` だけが空文字を値として受けていた不一致を #26 で修正済み |
| 耐久性の範囲 | ファイルの `fsync` はある。ディレクトリの `fsync` が無いので、宣言どおり保証はプロセスの再起動まで（PR 1 で OS クラッシュまで広げる） |

### 10.2 分割の原則

1. **1 PR = 1 改訂 = `docs/fidelity.md` の 1 行（か 1 文）。** Plan A は凍結済みで、以後の変更は改訂として記録する（対応表の冒頭）。
2. **直列に出す。** 残件はどれも `src/engine/persist.ts` と、対応表の「状態の永続化」「同一状態ファイルの多重起動」の節を触る。対応表は 1 項目 1 小節なので、同じ小節を触る PR を並行に出すと衝突しうる（v0.1.0 当時は 1 項目 1 行の表で、同じ行を触れば必ず衝突した）。
3. **判断が要るものと要らないものを分ける。** 決定待ちで全部を止めない。最大の項目（persist 失敗）は「記録・可視化」と「方針」に割り、前者を決定不要で先に出す。

### 10.3 出す順序

| # | 内容 | 判断 | 主に触る所 | 状態 |
|---|---|---|---|---|
| 1 | `rename` 後のディレクトリ `fsync` | 不要 | `saveState()` / 対応表「状態の永続化」 | **完了** |
| 2 | persist 失敗を store が覚え、`GET /_control/state` に出す | 不要 | `SessionStore` / `control.ts` / 同上 | **完了** |
| 3 | persist 失敗時は状態変更を断り、読み取りは生かす | **決定済み（10.5）** | `SessionStore` / `http.ts` / `config.ts` / 同上 | **完了** |
| 4 | 起動時の排他ロック | **決定済み（12.2）** | `src/store/lock.ts`（新規）/ `src/index.ts` / 対応表「多重起動」/ README | **完了** |
| 5 | 起動時の孤児 `.tmp` 掃除（任意） | 不要 | `sweepOrphanTempFiles()`（`persist.ts`）/ `src/index.ts` / 対応表「状態の永続化」 | **完了** |

**PR 1 を先頭に置くのは順序の都合**（対応表の同じ行を 3 つの PR で取り合わないため）で、規模が最小なので PR 2 と入れ替えてもよい。**PR 5 は PR 4 の後でだけ安全**である。ロックが無い間は、他プロセスが書いている最中の一時ファイルを消しかねない。

### 10.4 各 PR の中身

**PR 1 — ディレクトリの `fsync`。** `rename` の直後に `dirname(path)` を開いて `fsync` する。保証範囲が「プロセスの再起動まで」から「OS ごと落ちた場合まで」に広がる。**ディレクトリの `fsync` は一部のファイルシステムで失敗する**（ネットワーク FS で `EINVAL` など）ので、失敗は warn に留めて `saveState()` の成否には昇格させない。昇格させると、今まで書けていた環境が書けなくなる。

PR 1 で 1 点、PR 3 が引き取るべきものが見つかった。**`SessionStore.write()` の `this.logger.warn()` は素で呼んでいる**ので、logger が投げると `persist()` が reject してルートが 500 になる。`npm run dev | head` のように標準出力が閉じた後の `console.warn` は `EPIPE` で投げるので、想像上の経路ではない。PR 3 は `write()` の戻りで劣化を決めるため、ログの副作用でその判定が動かないようにする（`saveState()` 側は PR 1 で握り潰し済み）。

PR 1 のマージ直後に CodeRabbit から「diff の外」の指摘が 2 件届き（GitHub の制約でインラインに出せず、マージに 1 分間に合わなかった）、どちらも実測で再現した。**葉だけの fsync では`mkdir -p` が新しく作った階層のエントリが親に残らない**（既定のパスは初回に 3 段作る）ことと、**warn が fs のエラーメッセージを生のまま埋めていた**こと（パスは `BITBANK_MOCK_STATE_PATH` 由来なので改行でログ行を割られる）。どちらも後追いで直した。

**PR 2 — 失敗の記録と可視化。** `SessionStore` が最後の persist 失敗（時刻・メッセージ・連続失敗数）を持ち、`GET /_control/state` に添える。互換ルートの応答も封筒も変えないので決定不要。PR 3 の土台であり、方針を決めるための実測材料でもある。

**PR 3 — 失敗時に状態変更を断る。** 10.5 の決定に従う。`SessionStore.write()` の `EPIPE` の穴は **PR 2 で閉じた**（当初は PR 3 へ回す予定だったが、CodeRabbit の指摘で実測したところ、発注がメモリ上で成立しているのにルートが封筒でない 500 を返し、クライアントの再送が二重注文になる経路だった。10.5 で「巻き戻さずに失敗を返すだけ」を却下した理由がそのまま現れる形なので、`write()` を書き換える PR 2 の範囲で直した）。

**`SessionStore.tick()` の 4 か所の `this.logger.warn()` は素のまま残す（PR 3 で決着）。** logger が投げるとルートは 500 になるが、tick の warn は**状態を変える前**に出るので、そのとき何も起きておらず応答と状態は食い違わない。`write()` の穴だけが「成立しているのに失敗が返る」形だったので閉じた。劣化との相互作用も無い: 劣化中の `tick()` は先頭で早期 return するので、これらの warn には到達しない。

**PR 4 — 起動時の排他ロック。** 対応表「同一状態ファイルの多重起動」の**既決事項を書き換える PR**。現行の根拠は「書き込みロックを入れてもプロセスごとに状態と採番が分かれるので、注文の消失と id 重複は防げない」だが、これは**書き込みロック**についての議論である。起動時の排他は状況そのものを作らせない別の機構だ、というのが新しい根拠になる。設計の要点は stale lock で、`<state path>.lock` を `wx` で作って pid を書き、`EEXIST` なら `process.kill(pid, 0)` で生存を見て、死んでいれば奪う。これが無いと `SIGKILL` の後に二度と起動できないという、今より悪い footgun になる。README の警告文も差し替える。

**PR 5 — 孤児 `.tmp` の掃除（任意）。** `rename` の前に落ちたプロセスが残す一時ファイルは、起動でも以後の書き込みでも片付かない（実測）。読むのは `state.json` だけなので無害だが、状態ディレクトリに溜まる。**2026-09-17 に PR 4 の後で入れた。** 前提どおり、起動・発注・停止を通しても残ることを今日の HEAD で確かめてから書いた。派生して決めた点は 3 つ。

- **掃除するのは排他を取ったあと。** 10.3 が PR 5 を PR 4 の後に置いた理由がそのまま実装の順序になる。そのため呼ぶ場所も `loadOrInitDefault()` ではなく `src/index.ts`（PR 4 と同じ判断）
- **消すのは自分が作りうる形だけ。** 状態ディレクトリは利用者が `BITBANK_MOCK_STATE_PATH` で指す場所なので、`.tmp` で終わるというだけで消さない。pid と乱数の段まで一致するものに絞る
- **乱数の段を空にしない。** `Math.random()` は `0` を返しうる仕様で、そのとき `slice(2, 10)` は空文字になり、名前が `<状態ファイル>.<pid>..tmp` という**掃除が拾えない形**になる（実測で確認）。確率は 2^-53 だが、外れたときの壊れ方が下記の「黙って効かなくなる」そのものなので潰した（CodeRabbit の指摘）
- **照合する pid の段は先頭が 0 でない 10 進数に限る。** `${process.pid}` は正の整数をそのまま文字列にしたもので、`0` もゼロ詰めも作らない。`\d+` のままだと、利用者が置いた `<状態ファイル>.00123.<乱数>.tmp` を消しうる（CodeRabbit の指摘）
- **照合する乱数の段は 1〜8 文字に限る。** 生成側が `slice(2, 10)` で 8 文字までしか作らない以上、それより長いものは自分の残骸ではない。`+` のままだと利用者が置いた `<状態ファイル>.<数字>.<9 文字以上>.tmp` を消しうる（同上）
- **`readdir` の失敗は `ENOENT` だけ黙って 0 にする。** 初回起動でディレクトリが無いのは想定内だが、権限が無い等は運用者が知るべき事情なので warn に出す。どちらでも起動は止めない（同上）
- **名前の生成と照合を隣に置く。** `tempFilePath()` と `orphanTempPattern()` は対で、片方だけ変えると掃除が自分の残骸を拾えなくなる。しかも掃除は「見つからない」を失敗として報告しないので、**黙って効かなくなる**。テストは名前を手で書かず、`saveState` に実際に書かせてそのとき開かれた一時ファイルのパスをそのまま使う（隔離コピーで、生成側だけ変えると落ちることを確認）

### 10.5 要判断事項（9 節の続き。2026-09-14 に決定）

8. ~~persist に失敗したとき、呼び出し元と応答に何を起こすか~~ → **決定: 状態を変える要求を断り、読み取りは生かす。既定 on。**（2026-09-14、PR 3）

決定の骨子は 4 点。

1. **既定 on。** 環境変数は残すが役割を逆にする。安全側を既定にして、env は切るための逃げ道にする。守るべき既存利用者がいないので、いま既定を変えるのが一番安い。
2. **挙動変更として記録する。** 対応表と README に、v0.1.0 からの変更として書く。黙って変えないための手当ては、既定を off にすることではなく、書いて渡すこと。
3. **プロセスは殺さない。** 書き込みに失敗したあとにシナリオを読み出せるかどうかが、実験ツールとしての差になる。利用側の設計にも同じ語彙（fail-closed / stale）があるので、説明もそのまま通る。**実装が高くつくと判明したらプロセス停止に落としてよい。その場合は理由を報告する。**
4. **`persist()` の側に置く。** ルートごとに手当てしない。`SessionStore.tick()` が market モードで内部から呼ぶ経路が抜けるため。

骨子から派生して決めた点。

| 論点 | 決定 |
|---|---|
| 失敗した当の要求 | **断る。** ただし巻き戻さないので、メモリには注文が残り応答は失敗になる。この非対称は対応表に明記する。劣化中は再送も断られるので二重注文にはならず、残った注文は読み取りで発見できる。「2xx を返して再起動で消える」より良い、という判断 |
| 劣化中の `tick()` | **約定を止める（読み取り専用にする）。** 止めないと market モードでは読むたびにメモリだけ進み、ファイルとの差が開き続ける |
| 復帰手段 | **入れない。** ディスクを直す → `GET /_control/state` でシナリオを読み出す → 再起動、が復帰手順。劣化中は何も書けないので自動再試行の契機が無く、`/_control/` に再試行の口を足すと control の表面が増える。必要になったら別 PR |
| 断り方 | 互換ルートは封筒 + `ErrorCode.INTERNAL`（70001。採番の飽和で既に使っている）。`/_control/` は素の JSON + **503**（README が挙げる 400 / 403 / 404 / 409 に追記する） |
| 置き場所の実体 | `buildServer()` に preHandler フックを 1 本。root のフックは `register()` したプラグインにも継承されるので、互換ルートと `/_control/` の両方に効く。**ただし `POST /v1/user/spot/orders_info` は読み取り**なので、「POST = 状態変更」では判定できない（注文状態の照合の主経路を劣化中に殺す）。状態を変える経路を明示列挙し、列挙漏れを落とすテストを置く |
| env | `BITBANK_MOCK_PERSIST_FAILURE=degrade`（既定）/ `ignore`（v0.1.0 の挙動）。`fillMode()` と同じ名前付きモードにするのは、骨子 3 の撤退先である `exit`（プロセス停止）を第 3 の値として足せるようにするため |

**テストの完了条件。** 書き込み失敗はモックせず実際に起こす（状態ファイルのパスをディレクトリにすると `rename` が必ず `EISDIR` で落ちる）。その上で次の 4 つを見る。

1. 変更系が全部断られる（`order` / `cancel_order` / `cancel_orders` / `/_control/` の `fill`・`tick`・`clock`・`reset`）
2. **読み取り系が全部 200 で、メモリの状態を返す**（`GET order` / `orders_info` / `active_orders` / `trade_history` / `assets` / `GET /_control/state`）
3. 劣化中に読み取りを叩いても `tick()` が約定させない（market モード）
4. `BITBANK_MOCK_PERSIST_FAILURE=ignore` で v0.1.0 の挙動（2xx + warn）に戻る

**2 が完了条件である。**

**採らなかった案。**

- **巻き戻して失敗を返す。** 安全でない。`persist()` は必ず `await` 越しなので、その間に他の要求が割り込んで新しい状態の上に積める（#16 で入れた書き込みの合流がまさにこれ）。巻き戻すと、割り込んだ側の注文まで捨てる。
- **巻き戻さずに失敗を返すだけ。** 応答は失敗・メモリは成功になり、クライアントの再送が二重注文になる。劣化モードを伴わない限り、今より悪い。
- **プロセスを止める。** 姿勢としては本リポジトリの fail-closed（壊れた state では起動しない）と揃うが、失敗後にシナリオを読み出せなくなる（骨子 3）。撤退先としては残す。
- **何もせず warn だけ（v0.1.0 の挙動）。** `ignore` として env に残す。

### 10.6 入れないもの

- `loadState()` の失敗メッセージの接頭辞（JSON のパース失敗も `failed to read paper state:` になり、読み取り自体は成功しているのに「read に失敗」と読める）。実害が無く、既存の PR に相乗りさせると範囲が広がる。やるなら単独の極小 PR で、優先度は最下位。
- `deleteState()` の未使用 export（参照はゼロ）。将来 `/_control/` に hard delete を足すかで決まるので、今は触らない。

## 11. v0.1.0 以後の改訂: 構造診断の残件（2026-09-17）

2026-09-17 に、コードが構造的に破綻していないか（循環依存・責務の境界・重複・dead code など）を
診断した。修正できるものは第 1 波（#33〜#35）と第 2 波（#36〜#38）で片付き、残った 3 つはどれも
判断が要るものだった。本節はその決定を固定する。10 節と同じく**決めてから書く**。

### 11.1 診断で確かめたこと（根拠として残す）

| 観点 | 結果 |
|---|---|
| 規模 | src 24 ファイル / 3,280 行、tests 23 ファイル / 6,162 行（テスト比 1.9:1） |
| 循環依存 | **実行時はゼロ。** 型のみの循環が 1 件（`engine/candles.ts` ↔ `engine/types.ts`、双方 `import type`）。`import type` を除いた import グラフで実測 |
| 層の逆流 | **実行時の逆流は無い。** `store/session.ts` から `routes/*` へ実行時に到達する経路はゼロ。型のみなら `session.ts` → `server/degraded.ts` → `routes/envelope.ts` の 1 本がある（`PersistFailureMode` の `import type`）。当初「store が routes に依存している」と報告したが、これは型を辺に数えたグラフによる**誤りだった** |
| ネストの深さ | 最大 3。4 段以上はゼロ |
| 関数の長さ | 50 行以上は 182 個中 11 個。ハンドラ単位では 14 個中 2 個。`placeOrder` は #35 で 84 行 → 58 行 |
| dead code | `touchedAssets`（4 生成点・0 読み手）と参照 0 の export 4 個を #34 で削除。`deleteState` は 10.6 の保留に従い残す |
| error code の定義元 | `ErrorCode` と `params.ts` に二重定義されており、片方だけ直しても typecheck とテストを素通りすることを実測。#33 で一元化し型で締めた |
| 許容差 | 不変量 6 の `1e-9` に根拠の記録が無く、残高が約 `8.39e6` を超えると 1 ulp を下回ることを実測。誤判定の具体例は作れなかったので値は変えず、`docs/fidelity.md` に未確定として記録（#36） |

### 11.2 要判断事項（10.5 の続き。2026-09-17 に決定）

**9.** ~~責務の逆流をどこまで直すか~~ → **決定: `freshState` を `engine/state.ts` へ移すだけ。**

当初は `FillMode` / `PersistFailureMode` の型の置き場まで含めて整理する案だったが、11.1 のとおり
**実行時の逆流は存在しない**。残りは実行時に何も変わらない整形で、十数箇所の import 書き換えに
見合わない（Plan A の開始まで 2 週間）。`freshState` だけは参照が 3 箇所（定義側 `store/session.ts`、
利用側 `routes/control.ts`）で、`PaperState` を作る関数が engine にある形が明らかに正しいので移す。

`server/degraded.ts` が bitbank 封筒を作るために `routes/envelope.ts` を読む向きの歪みは**残す**。
型のみの循環（`candles.ts` ↔ `types.ts`）も残す。どちらも記録で足りる。

移動後に層をまたぐ import を数え直した。**`routes` から `store` を読む実行時の辺は 0 になった。**
移動前は `routes/control.ts` の `freshState` 1 本だけだった。

```text
=== BEFORE (origin/main) routes -> store ===
src/routes/control.ts:10:import { freshState } from "../store/session.ts";
=== AFTER routes -> store ===
  (なし)
=== 参考: server -> store ===
src/server/http.ts:11:import type { SessionStore } from "../store/session.ts";
```

残る `server → store` は `SessionStore` の `import type` 1 本で、実行時には消える。
`store → routes` と `engine → store / routes` は移動前から 0 のまま。

**10.** ~~検証をどこに置くか~~ → **決定: 規則を明文化し、実装は変えない。**

規則は `docs/fidelity.md` の「検証をどこに置くか」に書いた。**engine は自分の計算と不変量が
成り立つために要る検証だけを持ち、routes は wire 上の契約（桁・欠落・型）を持つ。**

「engine は不変量のための検証だけ」という言い方は採らなかった。`price > 0`（`transitions.ts`）は
6 本の不変量のどれでもなく `notional = price * fillAmount` の前提なので、その規則では次に検証を
足す人がどちらに置くかを引けない。「計算と不変量のために要る」なら `price > 0` が engine に、
桁が routes にあることを両方説明できる。

engine 側に桁検査を足す案（挙動が変わる）は採らない。桁の検査はもともと量を格子へ載せる保証では
なく（不変量 5 の節の末尾）、engine の計算はその保証に依存していない。

**11.** ~~`await store.tick()` の 8 箇所~~ → **決定: テストで固定する。フックへは移さない。**

`preHandler` フックへ移す案は採らない。`buildServer()` の劣化ガードと実行順が絡み、
`create-order` の「tick → `getLatestPrice`」のようなルート固有の並びがフックに隠れる。

テストは**ルートの一覧を手書きしない**。手書きすると、塞ごうとしている「新しいルートで足し忘れる」
がテスト側で起きる。`src/server/degraded.ts` の `READ_ROUTES ∪ MUTATING_ROUTES` から導出する。
`assertRouteClassified()` が `onRoute` で登録済みルートの網羅を起動時に保証しているので、
ルートを足した人は `degraded.ts` に足さないとサーバが起動せず、このテストが自動で拾う。
維持する場所は 1 つだけになる（#30 の発想の流用）。

Fastify は列挙 API を持たない（`app.routes` / `getRoutes` / `router` はいずれも `undefined`、
`printRoutes()` は接頭辞圧縮された木）ことを確認済み。

実装は `tests/routes/tick.test.ts`。手書きが 1 つだけ残った。**ルートごとの「検証を通る最小の要求」**で、
`tick()` が入力の検証より後に走る以上これは避けられない。ただし鍵の集合との一致を 1 本のテストで
突き合わせているので、足し忘れは「黙って無検査で通る」ではなく落ちる失敗になる。メソッドと url は
鍵から組み立てるので、鍵と食い違う url を撃つこともできない。

この検査が無かったときに何が素通りするかを実測した。`await store.tick()` を 1 箇所ずつ消して全テストを
走らせると、既存のテストが拾ったのは 3 箇所（`GET /v1/user/spot/order`・`POST /v1/user/spot/orders_info`・
`GET /v1/user/spot/active_orders`）だけで、残る 5 箇所は 325 件すべて green のまま消せた。
新しいテストは 8 箇所すべてで落ちる。

### 11.3 出す順序

| # | 内容 | 判断 | 主に触る所 |
|---|---|---|---|
| 7 | 決定の記録と検証の規則の明文化 | 11.2 の 3 件 | `docs/plan-lab-mock.md`・`docs/fidelity.md` |
| 8 | 互換ルートが tick を通ることをテストで固定 | 11.2 の 11 | `tests/` |
| 9 | `freshState` を `engine/state.ts` へ移す | 11.2 の 9 | `src/engine/state.ts`・`src/store/session.ts`・`src/routes/control.ts` |

### 11.4 入れないもの

- **型のみの循環**（`engine/candles.ts` ↔ `engine/types.ts`）。実行時に消えるので実害が無い。`Candle` を `types.ts` へ移せば解消するが、それだけのために import を書き換える価値は無い。
- **`FillMode` / `PersistFailureMode` の型の置き場**（11.2 の 9）。実行時に何も変わらない。
- **`server/degraded.ts` → `routes/envelope.ts` の向き**。層としては逆だが、劣化時の応答を 1 箇所に置くという `buildServer()` の設計（10.5 の骨子 4）から来ている。分けると劣化ガードが 2 箇所になる。

### 11.5 診断で挙げて、9 本のどれにも入れなかったもの（記録のみ）

10 節・11.4 に載らないまま残っていた 5 件。**どれも挙動を変えない整理で、実害が小さいか、
分割すると却って読みにくくなる。** 次に同じものを見つけた人が、発見からやり直さずに済むよう
ここへ書く。値も挙動も変えていない。

| # | 内容 | 実測（2026-09-17、`d6200cd`） | 入れない理由 |
|---|---|---|---|
| 1 | `reply.code(400);` + `return err(ErrorCode.INVALID_PARAMETER);` の反復 | **11 箇所**。`cancel-order.ts:22,31,51,60`・`create-order.ts:47,56`・`order-info.ts:15,20,35,43,48` | 下記のとおり、**まとめると危ない**。同じ `reply.code(400)` でも 7 箇所は専用コードを返している |
| 2 | `e instanceof Error ? e.message : String(e)` の反復 | **5 箇所**。`candles.ts:141`・`persist.ts:296,353,411,440` | 1 行の定型。関数へ括り出しても呼び出し側の行数は変わらず、`catch` の中で何を握っているかが 1 段遠くなる |
| 3 | `cancel_orders` の畳み込みが routes にある | `cancel-order.ts:79-95`。engine の公開遷移は `placeOrder` / `fillOrder` / `cancelOrder` / `rejectOrder` の 4 つで、**複数取消の関数は無い** | engine へ移すと、飛ばす条件（存在しない id・別ペア・重複）が engine の関心事になる。これらは wire の契約であって計算の前提ではない（11.2 の決定 10 の規則） |
| 4 | `match.ts:55` の到達しない分岐 | `if (!r.data.trade) return ...`。`fillOrder` の成功経路は 1 本だけで、必ず `trade` を詰める（`transitions.ts:234` の `return ok({... trade })`） | `TransitionOk.trade` が optional なので**型の都合で必要**。消すと型検査が通らない。optional を外すのは 4 つの遷移関数すべてに波及する |
| 5 | 封筒に包むかを URL の前置きで判定している | `degraded.ts:84` の `url.startsWith("/_control/")`。**実行時にこの判定をしているのはこの 1 箇所だけ**（他の `/_control/` はコメントかルート鍵の文字列） | 判定を経路の属性へ持たせる案はあるが、`READ_ROUTES` / `MUTATING_ROUTES` に 3 つ目の軸が増える。1 箇所の文字列判定のほうが読み手の負担が小さい |

**4 が「型の都合」である根拠**（隔離コピーで実測）。`match.ts:55` の
`if (!r.data.trade) return ...` を消して `npx tsc --noEmit` を走らせると落ちる。

```text
src/engine/match.ts(55,56): error TS2322: Type '{ ... } | undefined' is not
assignable to type '{ ... }'.
  Type 'undefined' is not assignable to type '{ ... }'.
```

到達しない分岐だが、`TransitionOk.trade` が optional である限り消せない。

**1 をまとめてはいけない理由**（これがこの節で一番残す価値のあること）。互換ルートで
`reply.code(400)` を返す箇所は 18 あり（`/_control/` の 22 箇所は封筒を使わないので別勘定。
`control.ts` の `err(ErrorCode...)` は 0 件）、うち 11 が汎用の `20003`、
**7 は専用のコードを返している**
（`MISSING_ORDER_ID` / `MISSING_ORDER_IDS` / `missingCreateOrderCode()` の戻り値 /
`queryParamErrorCode()` が引き当てる `40006` 等）。後者は実 API の実測に基づく値で
（`docs/fidelity.md` の「絞り込みパラメータの不正値」）、**モックが本物に寄せている中身そのもの**。
「400 を返す箇所」を機械的に 1 つのヘルパへ寄せると、この 7 箇所が汎用コードへ潰れる経路が
できる。まとめるなら汎用の 11 箇所だけを対象にし、専用コードの経路には触れないこと。

## 12. v0.1.0 以後の改訂: 起動時の排他（2026-09-17）

10.3 の残件のうち唯一「判断が要る」ものだった PR 4。対応表の**既決事項を書き換える**ので、
書く前に根拠を取り直した。

### 12.1 排他が無いと何が起きるか（今日の HEAD で実測）

2026-09-14 の診断（10.1）と同じ現象が、今日の `7c7f1ef` でもそのまま再現した。同じ
`BITBANK_MOCK_STATE_PATH` を指す 2 プロセス（port 14041 / 14042）へ 3 本ずつ発注した。

```text
A(14041) が払い出した order_id: 1 2 3
B(14042) が払い出した order_id: 1 2 3
それぞれのプロセスが覚えている注文数: A=3 B=3
状態ファイルに残っている注文: id 1/2/3（price 4000000 番台 = B のぶんだけ）
```

**6 本すべてに `success: 1` を返しながら、A の 3 本は状態ファイルに 1 本も残らない。**
`order_id` も重複するので、クライアントから見ると「id 1 の注文」が 2 つ存在する。

### 12.2 要判断事項（11.2 の続き。2026-09-17 に決定）

**12.** ~~対応表の「ロックを足さない」を維持するか~~ → **決定: 起動時の排他を入れ、既決事項を書き換える。**

旧根拠は「書き込みロックを入れてもプロセスごとに状態と採番が分かれるので、注文の消失と id 重複は
防げない」だった。これは**書き込みロックについての議論**である。起動時の排他は状況そのものを
作らせない別の機構で、12.1 で実測した消失と重複はどちらも起きなくなる。

派生して決めた点。

| 論点 | 決定 |
|---|---|
| 置き場所 | `src/index.ts`（サーバの起動経路）から取る。**`loadOrInitDefault()` には入れない。** 防ぎたいのは「サーバが 2 つ動く」ことで、`loadOrInitDefault()` は状態ファイルを読み直すだけの用途でも使われる（テストが同じパスに対して繰り返し呼ぶ）。ロックの寿命はサーバの寿命と同じなので、シグナル処理と同じ場所に置く。10.3 の表は `loadOrInitDefault()` と書いていたが、実装時にここだけ変えた |
| 層 | 新規モジュールは `src/store/lock.ts`。`engine/persist.ts` の隣ではない。pid とシグナルはプロセスの寿命の話で、11.2 の決定 10 の規則（engine は自分の計算と不変量のために要るものだけ）に当たらない |
| 保持者の判定 | `<状態ファイル>.lock` に pid を 1 行。`process.kill(pid, 0)` で生死を見る。**`ESRCH` だけを「居ない」の証拠にし、それ以外はすべて生きている側に倒す**（`EPERM` は居るが権限が無い、残りは判定できなかったということ。どちらも奪う根拠にならない）。倒す先を間違えたときの重さが非対称で、生きている側のロックを奪うと二重起動を作るのに対し、起動を断る側の誤りはメッセージを読んでロックファイルを消せば直る。**当初は `EPERM` だけを true にしていた**（CodeRabbit の指摘で是正） |
| stale の扱い | 死んだ pid のロックは奪う。奪わないと `SIGKILL` の後に二度と起動できないという、今より悪い footgun になる（10.4 のとおり） |
| 作りかけのロック | **pid を書けなかったら消してから投げる。** 残すと中身が空のロックになり、`readHolderPid()` が `null` を返して以後どの起動も奪わない。ディスクが一杯になった一度きりの失敗で、**手でファイルを消すまで二度と起動できなくなる**（stale を奪う理由と同じ形の footgun）。`close()` の失敗も同じ扱い。掃除は best effort で、消せなくても元の例外を返す |
| 停止経路の例外 | **`shutdown()` から例外を出さない。** シグナルハンドラは `void shutdown(signal)` で呼ぶので、`fastify.close()` の失敗がそのまま出ると unhandled rejection になり、**`process.exit()` に到達しないまま**ランタイム任せで落ちる（同じ制御の流れを再現して、スタックトレース付きの終了コード 1 になることを実測した）。`close()` の失敗は捕まえて終了コード 1 に落とし、`process.exit()` は `finally` から呼ぶ。**この 1 件はテストで固定していない**——`fastify.close()` を外から失敗させる手立てが無く、そのためだけに停止処理を注入可能な形へ組み替えるのは割に合わないと判断した（CodeRabbit の指摘） |
| 解放の失敗 | `release()` は `ENOENT` 以外の失敗を reject する。**解放済みと記録するのは消せてから**で、先に記録すると失敗した回にプロセス終了時の保険まで無効になる。呼び出し側（`src/index.ts`）は停止経路でも listen 失敗の経路でも握り潰して warn に落とす。停止を止めず、listen の失敗を後片付けの失敗で隠さないため |
| pid が読めないロック | **奪わない。** 空のロックファイルは、別プロセスが `wx` で作った直後でまだ pid を書いていない瞬間にも現れる。「中身が無い＝死んでいる」と扱うと、防ごうとしている二重起動をそこで作る。手で消せる旨をメッセージに出して終わる |
| pid 再利用 | **防がない。** 死んだ pid が別プロセスに再利用されると「生きている」と判定して起動を断る。起動しないほうへ倒れるので黙って壊れることは無く、メッセージがロックファイルのパスと消し方を出す |
| 競合の残り | **防ぎ切らない。** 2 プロセスが同じ stale ロックを同時に奪いに行くと、消した直後に作る順序で両方が取得しうる。取得後に pid を読み直して窓は狭めたが、消すには `flock` が要り Node は標準で持たない。人が 2 回起動する現実の間隔では起きないが、対応表には**「起きない」ではなく「窓が狭い」**と書く |

### 12.3 テスト

`tests/store/lock.test.ts`（11 件）がロック自体を、`tests/index.test.ts`（1 件）が**配線**を見る。

分けたのは、`src/index.ts` から `acquireStateLock()` の呼び出しを外しても**既存の 398 件が 1 件も
落ちない**ためである（隔離コピーで実測）。11.2 の決定 11 で `await store.tick()` について確かめたのと
同じ形で、消しても誰も気づかない呼び出しだった。`tests/index.test.ts` はサーバを 1 本だけ起こし、
走っているプロセスがロックを持っていること・`SIGTERM` で手放すことを見る（2 本起こして弾かれる側の
標準エラーを読むより安い）。

`tests/index.test.ts` 自身に 2 つ穴があり、どちらも実行して見つけた。**サーバを起こすテストを
書くなら同じ 2 点を踏む**ので記録する。

- **固定ポートにしていた。** 単体で走らせると通り、全体で走らせると落ちた。原因は別プロセスが
  同じポートで応答していたこと（手元の実験の残骸）で、HTTP で待つ実装だと**取り違えたまま先へ進む**。
  空きポートを借りて渡し、待つのは自分が起こしたプロセスの標準出力（fastify の listen ログ）にした
- **`node_modules/.bin/tsx` で起こしていた。** ラッパが子の node を産むので `child.pid` はラッパのもので、
  後始末の `SIGKILL` が子へ届かない。テストが落ちた回に**サーバがポートとロックを握ったまま孤児として
  残り**、後続の実行を壊した。`node --import tsx` なら 1 プロセスなので、`child.pid` がそのまま
  サーバの pid になる（ロックの中身と一致することを検証にも使える）

ロック側の 7 つの退行も隔離コピーで確かめ、いずれも意図した 1 件だけが落ちた。

| 入れた退行 | 落ちたテスト |
|---|---|
| 生死を見ず、常に奪う | 「生きているプロセスが持っている間は取れない」ほか 1 件 |
| pid が読めないロックを stale 扱いにする | 「pid が読めないロックは奪わない」 |
| stale を奪わない | 「死んだ pid のロックは奪う」 |
| 階層を作らない | 「状態ファイルの階層がまだ無くても取れる」 |
| `isAlive` を `EPERM` だけ true に戻す | 「生死を判定できないときは奪わない」 |
| `tryCreate` の後片付けを外す | 「pid を書けなかったら、作りかけのロックを残さない」 |
| `release` で先に解放済みの印を付ける | 「消せなかった release は失敗として返り、次の release がやり直す」 |

書き込みと削除の失敗だけは実際に起こせない（ディスクを埋めるわけにいかず、root では
パーミッションも効かない）ので、`node:fs/promises` の `open` と `unlink` を旗で差し替えている。
他は実物をそのまま通す。

## 13. プラン B の実験能力の候補: サーキットブレーカー（2026-09-20、記録のみ）

公式 error code の全件スイープで見つかった `70020`（`errors.md:228`「Market order has been
temporarily restricted.」）の置き場所。**プラン A では実装しない**——理由と本物との差異は
`docs/fidelity.md` の「サーキットブレーカー時の成行制限」節が持つ。ここに書くのは
**忠実性の穴としてではなく、実験能力の候補として**の話である。

### 13.1 何を観測できるようになるか

`rest-api.md:403-405` の `**Caveat:**` は 2 項目あり、どちらも
`circuit_break_info.mode`（公開 API 側。`public-api.md:353` が `NONE` /
`CIRCUIT_BREAK` / `FULL_RANGE_CIRCUIT_BREAK` / `RESUMPTION` / `LISTING` の 5 値で定義）で
切り替わる。

- `NONE` 以外では**成行注文が `70020` で断られる**
- `NONE` 以外では **`post_only` が `false` として扱われる**

**価値は忠実度の側ではなく、「市場が止まっているとき利用側がどう振る舞うか」を観測できる
ことにある。** プラン A の実験面（`/_control/` の fill / tick）が扱うのは「約定が進む」方向で、
**「発注そのものを受け付けてもらえない」方向の経路は今どこにも無い**。発注停止ペアの
`70017` は静的な表から来る恒久的な制限なので、**一時的に止まり、また再開する**という
時間軸のある状態は再現できない。利用側の退避経路（指値へ切り替える・待って再送する・
`post_only` が効かない前提で組む）を踏ませられるのはこの仕組みだけである。

### 13.2 入れるとしたらどう入れるか（案。いま実装はしない）

| 論点 | 案 |
|---|---|
| 状態の置き場 | `PaperState` にペアごとの `circuitBreak` を持たせる（版を上げる）。**外部取得はしない**——本モックが起動時も要求処理中も外へ出ないという方針は既決事項で（`docs/fidelity.md` の「ペア」節にある `/spot/pairs` の項）、この 1 件のために崩さない |
| 注入口 | `POST /_control/circuit_break` に `{ pair, mode }` を取る。**`/_control/` を広げるのはプラン B での判断**にする（プラン A で誰も踏まない条件のために制御面を広げない） |
| 断る位置 | `src/routes/create-order.ts` の成行分岐に入る**前**。`store.tick()` より前に置けば、断ったときに状態を変えずに済む（`70017` と `60011` と同じ位置づけ） |
| `post_only` との関係 | `post_only` を実装した後でなければ 2 項目目は観測できない。**順序があるので、`post_only` の実装と同じ段で考える** |
| 公開 API 側 | `GET /{pair}/circuit_break_info` を生やすかは別の判断。利用側が**モードを読んでから発注を決める**筋を実験したいなら要るが、public REST の網羅はプラン A の非目標のまま |

**この節は記録であって決定ではない。** プラン B に着手するときに 9 節・10.5・11.2・12.2 と
同じ形で要判断事項として起こし直すこと。

---

## 14. R4: private stream の実装前調査（2026-09-21、記録のみ）

R4（private stream）に着手する前のギャップ分析。**この節は調査結果であって決定ではない。**
決まっていないものは 14.2 の要判断事項に送ってある。**`src/` は 1 行も触っていない。**

範囲は公式 `private-stream.md` / `private-stream_JP.md`（固定コミット `0badd680`）が定義する
11 メソッドのうち**現物の 5 つ**（`asset_update` / `spot_order_new` / `spot_order` /
`spot_order_invalidation` / `spot_trade`）。残る 6 つ（`dealer_order_new` / `withdrawal` /
`deposit` / `margin_position_update` / `margin_payable_update` / `margin_notice_update`）は
ディーラー・入出金・信用取引で、プラン A で互換を主張する範囲の外なので見ていない。

**この調査で 3.1 / 3.4 の記述を 8 箇所直した。** 計画が、実装が既に変えた構造の上に載っていた
（`touchedAssets` の削除・部分約定の受付・`params` の形・注文ペイロードの差・`asset_update` の
キー・発火漏れの主張・メソッド数）。**訂正は実装に合わせただけで、新しい設計は書いていない。**

### 14.1 調査で確かめたこと（根拠として残す）

#### (1) メソッド × フィールドの構成可能性

現在の `PaperState` / `OrderRecord` / `TradeRecord` から公式のペイロードを作れるか。

| メソッド | 値は作れるか | 足りないもの |
|---|---|---|
| `asset_update` | **作れる。** 6 フィールド（`asset` / 精度 / free / locked / onhand / withdrawing）はすべて `state.balances` と `computeLocked()` から出る。`formatAssets()` が既に同じ値を計算している | **「どの資産が変わったか」という発火情報**。`withdrawing_amount` は出金を模さないので常に `0`（REST 側と同じ扱い） |
| `spot_order_new` / `spot_order` | **ほぼ作れる。** `OrderRecord` から `formatOrder()` が 15 フィールドを出す。信用・逆指値のフィールド（`position_side` / `trigger_price` / `triggered_at`）は公式が `\| undefined` と定義し、本モックは該当機能を持たないので出さない（`docs/fidelity.md` の「信用取引・逆指値の項目」節と同じ扱い） | **`executed_at`** と **`is_just_triggered`**（下記） |
| `spot_order_invalidation` | 値は `order_id` だけなので自明に作れる | **発生条件そのもの。** 起こり得ないので実装しない（`docs/fidelity.md` の「private stream の `spot_order_invalidation`」節） |
| `spot_trade` | **作れる。** `TradeRecord` から `formatTrade()` が現物で意味を持つ 12 フィールドを全て出す | 無し |

**結論: 値はほぼ揃っており、足りないのは「どの資産・どの注文について通知するか」という
発火情報である。** フィールドの不足は下の 2 つだけで、どちらも構造の問題ではない。

- **`executed_at`**（`private-stream.md:120` / `private-stream_JP.md:121`）は
  `TradeRecord.executedAt` から**導出できる**（注文 id で trades を引けばよい）。ただし
  **公式は「最初 / 最後 / 直近のどの約定時刻か」を書いていない**——フィールド表の説明は
  "order executed at unix timestamp (milliseconds)" だけで、応答例も型しか示さない。
  **`OrderRecord` にフィールドを足す根拠はまだ無い。** 導出の規則が決まれば
  `formatOrder()` の外側で足せる
- **`is_just_triggered`**（`private-stream.md:136` / `private-stream_JP.md:137`）は公式の型が
  `boolean`（`\| undefined` が付かない）ので常に出る。本モックに逆指値のトリガという概念が
  無いので**載せる値を決める必要がある**が、**ここでは決めない**

#### (2) 整形関数の分類

| メソッド | REST との関係 | 共有できるか |
|---|---|---|
| `spot_trade` | REST の Fetch trade history の応答表（`rest-api.md:948-964`）と private の表（`private-stream.md:245-261`）が**同じ 15 フィールド**。並び順は違うが集合は一致する。**うち 3 つ（`position_side` / `profit_loss` / `interest`）は公式が `\| undefined` と定義する信用取引の条件付きフィールド**で、`formatTrade()` は残る**現物の 12 フィールド**を出す（`tests/routes/official-fields.ts` の `UNIMPLEMENTED_TRADE_FIELDS`） | **`formatTrade()` をそのまま共有できる。** 現物のペイロードとしては 12 フィールドで過不足が無いので、R4 のために `formatTrade()` を変える必要は無い（**信用取引を扱うようになったら別の判断**） |
| `spot_order_new` / `spot_order` | REST の Fetch order information（`rest-api.md:292-310`、17 フィールド）に対する**スーパーセット**（`executed_at` / `is_just_triggered` が追加。`canceled_at` は REST の Fetch order information の表に無いが本モックは既に出している——`docs/fidelity.md` の「注文の `canceled_at`」節） | **共通部分のみ共有**。分け方は未決 |
| `asset_update` | private のフィールド表の 6 つは REST の assets（`rest-api.md:189-201`、11 フィールド）の**名前の部分集合**。**ただし private の応答例は camelCase** | **命名が未確定なので決められない** |
| `spot_order_invalidation` | REST に対応物が無い | 実装しないので不要 |

**突き合わせで公式の食い違いがもう 1 つ出た。** REST の Fetch trade history は応答表に
`fee_occurred_amount_quote` を持つのに（`rest-api.md:961`）、**同じ節の JSON 応答例
（`rest-api.md:987-1011`）はそれを持たない**。private の `spot_trade` は表（`:251`）と
例（`:275`）の**両方**が持つ。本モックは従来どおり表の側に寄せてあり、**挙動は変えていない**
（`docs/fidelity.md` の「約定の固定フィールド」節に記録した）。

#### (3) 状態が変わる経路の一覧

「同じ遷移関数を通るので発火漏れが無い」という 3.4 の主張が成り立たないことの根拠。

**遷移関数を通る経路。**

| 経路 | 通る遷移関数 | 状態の反映 |
|---|---|---|
| `POST /v1/user/spot/order`（指値） | `placeOrder` | `commit()` 1 回 |
| `POST /v1/user/spot/order`（成行） | `placeOrder` → `fillOrder` | `commit()` 1 回（注文 1 + 約定 1） |
| `POST /v1/user/spot/cancel_order` | `cancelOrder` | `commit()` 1 回 |
| `POST /v1/user/spot/cancel_orders` | `cancelOrder` × n | **`commit()` 1 回。** n 件の結果を畳んで次状態だけを渡すので、**注文ごとの結果が `commit()` の引数に残らない**（`commit(next: PaperState)` は次状態しか受け取らない。`src/store/session.ts`） |
| `POST /_control/orders/:order_id/fill` | `fillOrder` | `commit()` 1 回 |
| `POST /_control/tick` | `runTick` → `applyFill` → `fillOrder` | `commit()` 1 回（約定は 0 件以上） |
| `SessionStore.tick()`（market モード） | `runTick` → `applyFill` → `fillOrder` | **`commit()` を通らない。** `_state` を直接差し替えて `persist()` を呼ぶ（`src/store/session.ts`）。約定が 0 件なら書き出しもしない |

**遷移関数を通らない経路。**

| 経路 | 何が変わるか |
|---|---|
| `POST /_control/reset` | `freshState()` で**状態を丸ごと差し替える**（注文・約定・残高・採番のすべて。`src/routes/control.ts`） |
| `POST /_control/clock` | `lastTickAt` と `updatedAt` **だけ**を動かす（注文・約定・残高は触らない） |
| `SessionStore.tick()` の末尾 | 約定が 1 件も無くても `lastTickAt` / `updatedAt` を上書きする |
| 起動時の読み込み | 状態ファイルから読む。v1 / v2 なら `migrateToLatest()` が形を変える |

**この一覧から言えるのは 2 つだけである。** (a) 遷移関数の戻り値だけを見る発火では
`/_control/reset` と `/_control/clock` を取りこぼす。(b) 一括取消と `SessionStore.tick()` は
`commit()` の引数から個々の注文・約定を復元できない。**どう扱うかは 14.2 の要判断事項 13 へ送る。**

### 14.2 要判断事項（12.2 の続き。**2026-09-27 に 16.1 で決定**）

**決定は 16.1 にある。** 以下は決める前に置いた論点・選択肢・代償の記録として、書き換えずに残す。

**ここに決定は書かない。** 論点と選択肢と代償だけを置く。R4 に着手するときに 9 節・10.5 /
11.2 / 12.2 と同じ形で決めて、決定を追記すること。

#### 13. 読み取り要求が private stream のイベントを起こしてよいか

**互換 8 ルートすべてがハンドラの先頭で `await store.tick()` を呼ぶ**
（`active-orders` / `assets` / `cancel-order` ×2 / `create-order` / `order-info` ×2 /
`trade-history`）。**11.2 の決定 11 で「テストで固定する。フックへは移さない」と決めた構造**
である。

market モードでは、**`GET /v1/user/assets` を叩いただけで約定が起き得る。** R4 後はそれが
`spot_trade` / `asset_update` として飛ぶので、利用側からは**「何もしていないのにイベントが
来る」**ように見える。

| 選択肢 | 代償 |
|---|---|
| そのまま発火させる | 実 API に近いのはこちら（本物でも約定は勝手に起きる）。ただし**発火の契機がモック固有**——本物は市場が動いたときに飛ぶが、モックは「誰かが読んだとき」に飛ぶ。読まない限り静かなので、利用側が「イベントが来ないから約定していない」と学習し得る |
| 読み取り由来の tick では発火させない | 実装は単純（発火の可否をハンドラから渡すだけ）。ただし**状態と stream がずれる**——`GET /v1/user/assets` の応答には出ている約定が、stream には流れない。このモックが一番避けたい種類の食い違いである |
| `fillMode: manual` を既定にして自動約定自体を避ける | 読み取りが約定を起こさなくなるので論点が消える。ただし**既定の変更**であり（control 無効時は今 `market`）、「起動しただけで板が動く」という既存の体験を変える。README と対応表の書き換えも要る |

**`asset_update` の発火情報をどこから取るかも、この項目に含める**（14.1 の (1) のとおり、
値は作れるが「どの資産が変わったか」が無い）。

| 案 | 代償 |
|---|---|
| `commit()` の前後で資産を比較する | **`src/` の変更が `SessionStore` に閉じる。** ただし `SessionStore.tick()` は `commit()` を通らないので（14.1 の (3)）、そこは別に手当てが要る。また全資産の比較になるため、資産が増えると比較のコストが乗る |
| 遷移の戻り値に変化資産を戻す | 発火情報が正確になる。ただし **`TransitionOk` / `applyFill` / `runTick` / 一括取消の畳み込みまで波及する**。#34 で `touchedAssets` を「4 生成点・0 読み手」として削除した経緯があるので、**戻すなら読み手を同じ PR で入れること**（また dead code にしない） |

#### 14. 永続化に失敗したとき、イベントと HTTP 応答が食い違ってよいか

書き込みに失敗したとき、**状態は先にメモリへ反映され、HTTP 応答だけが失敗に差し替わる**
（劣化モード。`docs/fidelity.md` の「状態の永続化」節。`commit()` は `replace()` を同期に
実行してから `persist()` を待ち、`persist()` は失敗しても throw しない）。

イベントを commit 時に出すと「**HTTP は失敗、stream は成功**」が起きる。

| 出す時点 | 性質 |
|---|---|
| commit 時（メモリへ反映した直後） | stream はメモリの状態と常に一致する。**HTTP が `70001` を返した要求のイベントが流れる**ので、利用側は「失敗したのに約定が来た」を見る |
| 永続化の成功後 | HTTP と stream が揃う。ただし**劣化後は状態が動いてもイベントが 1 つも流れない**（メモリ上は進んでいるのに stream が止まる）。`SessionStore.tick()` は約定が 0 件なら書き出さないので、**書き出しの有無が発火の有無になる**という別の食い違いも入る |
| HTTP 応答を返した後 | 「応答を見てから stream を待つ」利用側の順序期待に合う。ただし**発火が要求の寿命の外に出る**ので、応答を返した後で落ちたぶんは消える。`/_control/` 経路と `SessionStore.tick()`（要求に紐づかない）の扱いを別に決める必要がある |

**決めない。** 劣化モードそのものの扱い（10.5）と、`SessionStore.tick()` が `commit()` を
通らないこと（14.1 の (3)）の両方に跨がるので、R4 に着手するときに 13 と合わせて決める。

---

## 15. 公開 API 消費側の記録（2026-09-21、記録のみ）

`src/engine/candles.ts` が**実在の公開 API（`https://public.bitbank.cc`）を叩いている**ことに
ついての整理。**この節は調査結果であって決定ではない。** 決まっていないものは 15.2 の要判断事項に
送ってある。**`src/` と `tests/` は 1 行も触っていない。**

実装側は #82（応答の検証を公式のフィールド表・応答例に合わせる）と #83（取得の健全性を
`GET /_control/state` の `candles` から見えるようにする）で対応済みで、**この節が足すのは記録だけ**で
ある。公式との対応関係は `docs/fidelity.md` の「公開 Candlestick の消費」節、`candles` で何が見えるかは
`docs/fidelity.md` の「足の取得の健全性」節が持つ。ここにはその要約と、実装が触れていない 2 つの
論点（15.2）を置く。

### 15.1 調査で確かめたこと（根拠として残す）

#### (1) 何を叩いているか

| 項目 | 値 | 根拠 |
|---|---|---|
| ベース URL | `https://public.bitbank.cc`（`BITBANK_PUBLIC_BASE_URL` で差し替え可） | `public-api.md:26` / `public-api_JP.md:26` |
| パス | `GET /{pair}/candlestick/1min/{YYYYMMDD}` | テンプレートは `:299`、`YYYY` の定義は `:308`、**`1min` が `YYYYMMDD` の側**である注記は `:310-312` |
| 足の種類 | `1min` だけ。他の種類も他の公開エンドポイントも叩かない | enum は要求側 `:307` / 応答側 `:318` |
| 取得の契機 | `SessionStore.tick()`（`BITBANK_MOCK_FILL_MODE=market`、**未約定注文を持つペアだけ**）と、成行の発注が使う `getLatestPrice()`（`fillMode` が `manual` でも取りに行く） | 本モック固有 |
| 取得する日付 | 範囲の**始点の日と終点の日だけ**（`ymdJst()` は JST を日付の境界にする） | 本モック固有。**タイムゾーンは公式に根拠が無い** |

**パステンプレートの `{YYYY}` だけを読むと誤読する。** 書式は candle-type で分かれ、`1min` は
`YYYYMMDD` の側である（`:310-312`）。

**`tick()` からの取得は無条件ではない。** 外へ要求が出るのは、次の 4 つの門を抜けたときだけである。

| 門 | 抜けないとき |
|---|---|
| `fillMode` | `manual` なら `tick()` は先頭で返る（取得ゼロ） |
| 劣化 | `isDegraded()`（`persist.lastError` が非 `null` かつ `BITBANK_MOCK_PERSIST_FAILURE=degrade`）なら `tick()` は丸ごと抜ける |
| 時計 | `lastTickAt` が実時刻より先なら**全ペアで取得を飛ばす**（warn 1 本。`docs/fidelity.md` の「control の時計」節） |
| ペアの文字種 | 状態ファイル由来で `pairAssets` を通らないペアは飛ばす |

そのうえで、未約定注文を持つペアが無ければ取得はゼロである（`activeOrders()` から作った集合を回る）。

#### (2) 応答形と、どこまで公式どおりか

| 箇所 | 公式 | モック |
|---|---|---|
| `ohlcv` の先頭 5 要素 | **string**（フィールド表 `:319` の型 `[string, string, string, string, string, number][]`、応答例 `:331-340` も `"string"` 5 本） | **number でも受ける**（`numStr`）。**消費側が緩いのは意図的**で、公式どおりの応答はそのまま通る |
| `ohlcv` の 6 要素目 | unix ミリ秒（`:319`） | そのまま使う。窓（`fromMs`〜`toMs`）の絞り込みと約定時刻の算出に要る |
| candlestick 要素の `timestamp` | 必須フィールド（`:320`、応答例 `:341`） | **スキーマで要求するが値は使わない。** 公式の必須フィールドが来ていることの確認（zod は宣言しない限り欠落も位置違いも検出しない） |
| `type` | enum（`:318`、応答例 `:330`） | **要求した `1min` と一致しなければ失敗**（#82）。取得先を差し替えられるので、確かめないと 5 分足が 1 分足として流れ込む |
| `candlestick` の要素数 | **明記が無い**（応答例 `:328-343` は 1 要素） | 1 要素であることは要求せず、**要求した種類に一致する要素を選ぶ**。同じ種類が複数来たら失敗（どれを採るか決まらないため） |
| 空の `candlestick` | **明記が無い** | 「その種類の足が無かった」として**空の足を返す**（不一致にはしない） |

#### (3) 失敗したときどうなるか

失敗は 4 経路（HTTP 非 2xx / 封筒が `success: 1` でない / スキーマ不一致 / 例外）あり、**どれも
throw せず `Result` の失敗で返る**。`tick()` から呼んだぶんの扱いは 4 経路とも同じである。

- warn を出して、**その tick をそのペアの約定なしで継続する**
- **互換ルートは成功応答を返す。** 失敗は応答に漏れない（成行の発注が使う `getLatestPrice()`
  だけは別で、取得の失敗も窓に足が無いことも封筒の `70001` に潰れる）
- **失敗した窓は取り直さない**（`lastTickAt` はループを抜けた後に無条件で現在時刻へ進む）
- 見分ける手段は `GET /_control/state` の `candles` だけ（`docs/fidelity.md` の
  「足の取得の健全性」節）

#### (4) エラー応答の根拠は `errors.md` ではない

**公開 API の封筒の根拠は `public-api.md:24-37` を採る。**

- `errors.md:20`（英語版）は "Here is the format of error JSON payload:" と一般的に書くが、
  **日本語版 `errors_JP.md:20` は「プライベートAPIでエラーが起きた場合は下記のようなレスポンスが
  返ります。」と private API に限定している**
- **英日でスコープが違う。どちらかを正には選ばず、食い違っていることを記録する**
- `public-api.md:24-37` は公開 API について `{ "success": 0, "data": { "code": 10000 } }` を
  明示的に定義している（`:28` の本文と `:30-37` の例）ので、こちらを使う
- **その 1 行にも英日差がある**——英語版 `:28` は "Any endpoint can return an ERROR"、
  日本語版 `public-api_JP.md:28` は「リクエストに不正がある場合、以下のようなエラーレスポンスを
  返します。」で、後者は不正な要求に限定している。**これもどちらかへ寄せない**（モックの扱いは
  封筒の形だけに依存するので、この差は消費側の挙動を変えない）

#### (5) レート制限について分かっていること

- **`public-api.md` の `## General API Information`（`:24-37`）に数値上限の記述は無い**
  （ベース URL・`4XX` の意味・エラー封筒の 3 項目だけ。日本語版 `public-api_JP.md:24-37` も同じ）
- ただし `errors.md:42` に `10009`（"You sent requests too frequently. Retry later with
  decreased requests." / `errors_JP.md:42`）が定義される
- **取得は scheduler ではなく互換ルートの `store.tick()` から起きる。** つまり
  **「1 分足」は要求頻度の上限を意味しない**
- `10009` を食っても封筒が `success: 1` でない経路として warn に落ちるだけで、区別した扱いはしない
  （(3) のとおり）

### 15.2 要判断事項（14.2 の続き。**いずれも未決定**）

**ここに決定は書かない。** 論点と選択肢と代償だけを置く。実装するときに 9 節・10.5 / 11.2 /
12.2 / 14.2 と同じ形で決めて、決定を追記すること。

#### 15. 長い空白の後、足をどこまで取りに行くか

現在の `defaultFetchCandles()` は取得する日付を

```ts
const dates = new Set<string>([ymdJst(fromMs), ymdJst(toMs)]);
```

で決める。**始点の日と終点の日だけ**なので、**3 日以上空くと中間日を取得しない。**
`SessionStore.tick()` は取得の前に範囲を丸めない（`lastMs` は状態ファイルの `lastTickAt` を
`Date.parse` した値をそのまま渡す）ので、状態ファイルを数日置いて再開したときに起き得る。

**これは意図した clamp ではなく `Set` の副産物である。** そして**正しい挙動が自明でない。**

| 選択肢 | 代償 |
|---|---|
| 空白のぶんを全部取りに行く | 取りこぼしが無くなる。ただし**空白が 3 日なら 1 分足が 4,000 本超**（1 日 1,440 本）で、要求も日数ぶんに増える。そして**溜まっていた注文が一斉に約定する**——数日ぶんの値動きが再開直後の 1 回の tick に畳まれる。それが実験として望ましいかは別の話である |
| 直近 N 時間に clamp する | 空白が長くても直近だけを見るので、再開後の挙動が空白の長さに依らなくなり実験の再現性は上がる。ただし**clamp した境界を利用側が知る必要がある**（知らないと「約定するはずの注文が約定しない」に見える）。`N` を決める根拠も別に要る |
| 空白が長すぎたら約定させず警告する | fail-closed。取りこぼしを黙って埋めない。ただし**「長すぎる」の閾値を決める根拠が無い**。警告だけで止まるので、利用側が気づく手段も別に要る（取得の失敗ではないので `GET /_control/state` の `candles` には何も出ない） |

**公式は日付のタイムゾーンも複数日の一括取得も定義していない**（`public-api.md:308-312` は
書式だけ）ので、**どれを選んでも推測になる**。`ymdJst()` が JST を日付の境界にしている現在の
実装も同じく推測の上に載っている。

#### 16. 足の取得頻度をどう抑えるか

**キャッシュもスロットルも無い。** `tick()` は未約定注文を持つペアについて毎回 `fetchCandles` を
呼び、**互換 8 ルートすべて（読み取りを含む）が `tick()` を呼ぶ**（`active-orders` / `assets` /
`cancel-order` ×2 / `create-order` / `order-info` ×2 / `trade-history`。**11.2 の決定 11 で
「テストで固定する。フックへは移さない」と決めた構造**である）。**抑えるものが無いだけで、
`tick()` 自体は無条件に取りに行くわけではない**——15.1 の (1) の 4 つの門（`manual` / 劣化中 /
時計が先 / 不正なペア）を抜けたときだけ外へ出る。**以下はその門を抜けている場合の話である。**

つまり、**市場モードで劣化しておらず、時計も実時刻より先にないとき**、

> **未約定の注文が 1 本でもあれば、利用側が `GET /v1/user/assets` を叩くたびに、
> 実在の `public.bitbank.cc` へ 1〜2 回リクエストが飛ぶ**（始点の日と終点の日を取るので、
> 窓が日をまたぐ回は 2 回。未約定注文を持つペアが複数あればペアごとに）。

利用側が 1 秒ごとに照合すれば、**第三者の公開 API へ毎秒リクエストが行く。叩いているのは
利用者の環境からである。** 未約定注文が無ければ `tick()` からの取得はゼロなので、
**実験中がまさに未約定注文を持つ状態**であることが問題になる。

| 選択肢 | 代償 |
|---|---|
| `(pair, dateStr)` でキャッシュする | 同じ日の足を何度も取らない。過去日は不変なのでそのまま使えるが、**当日の足は増え続ける**ので TTL をどう決めるかが残る（長いと約定の反映が遅れ、短いと効かない）。効き方が「窓が日をまたぐか」に依存するのも読みにくい |
| tick 自体をスロットルする（最後の tick から N 秒未満なら取得しない） | 実装は単純で、**11.2 の決定 11（route-local tick を維持）とも矛盾しない**（ルートの並びは変えず `tick()` の中で早期に返る）。ただし**約定の反映が最大 N 秒遅れる**ので、発注の直後の照会で約定が見えない回ができる。`POST /_control/tick` を同じ扱いにするかも別に決める必要がある |
| 何もしない | 実験の規模なら問題にならないという判断。その場合は**利用側に「ポーリング頻度がそのまま公開 API への要求頻度になる」と伝える必要がある**（README と対応表）。伝えないと、利用側は自分が第三者の API を叩いていることに気づかない |

**決めない。** どれを採っても利用側から見える挙動（約定の遅れ、要求の量）が変わるので、
15 と合わせて実装するときに決める。

---

## 16. R4: private stream の実装（2026-09-27）

14 節の調査を受けて R4 を実装した。14.2 の要判断事項 13 と 14 をここで決め、実装で派生して
決めた点を固定する。**挙動の正は `docs/fidelity.md` の「private stream」から始まる一連の節**で、
ここは決定の理由を持つ。

### 16.1 要判断事項（14.2 の続き。2026-09-27 に決定）

**13.** ~~読み取り要求が private stream のイベントを起こしてよいか~~ → **決定: そのまま発火させる。発火情報は状態の差から取る。**

14.2 の 3 案のうち、「読み取り由来の tick では発火させない」は**状態と stream がずれる**
（`GET /v1/user/assets` の応答に出ている約定が stream に流れない）。このモックが一番避けたい
食い違いなので採らない。「`fillMode: manual` を既定にする」は既定の変更で、control を使わない
利用者の体験を変えるので R4 の範囲を超える。残る「そのまま発火させる」を採り、代償
（**発火の契機がモック固有で、誰も `GET /v1/user/subscribe` 以外の互換ルートか `/_control/` の fill / tick を叩かない限り静か**）は `docs/fidelity.md` の
「private stream の発火契機」節に書いて利用側へ渡す。

`asset_update` の発火情報は、14.2 の 2 案（`commit()` の前後で資産を比較する／遷移の戻り値に
変化資産を戻す）のうち**前者を一般化した**。

- **比べるのは資産だけでなく、注文と約定を含めた状態全体の差**にした。`spot_order_new` /
  `spot_order` / `spot_trade` も同じ差から作る
- **比べる場所は `commit()` ではなく、`SessionStore` が `_state` を書き換える唯一の口
  （`setState()`）**にした。14.1 の (3) の 2 つの穴——一括取消は n 件を畳んで 1 回だけ
  `commit()` する、`SessionStore.tick()` は `commit()` を通らない——は、どちらも「状態は差し替わる」
  ので、差を取れば埋まる
- 戻り値案は `TransitionOk` / `applyFill` / `runTick` / 一括取消の畳み込みまで波及し、しかも
  **新しい経路を足すたびに発火を書き足す必要が残る**（書き忘れても黙って抜ける）。`commit()` と
  `fetchCandlesTracked()` が「呼び忘れを構造的に無くす」形にしてあるのと同じ理屈で、1 か所に置いた

比較のコストは小さい。遷移関数は変えない注文のレコードを使い回し（`replaceOrder()`）、時計だけの
差し替えは `orders` / `trades` / `balances` を同じ参照のまま持つので、参照の一致で大半を飛ばせる。
購読者がいなければ差も取らない。

**14.** ~~永続化に失敗したとき、イベントと HTTP 応答が食い違ってよいか~~ → **決定: 食い違ってよい。イベントはメモリへ反映した直後に送る。**

14.2 の 3 案のうち、「永続化の成功後」は**劣化後にメモリが動いても stream が止まる**ことと、
**書き出しの有無が発火の有無になる**こと（`tick()` は約定 0 件なら書かない）の 2 つの食い違いを
持ち込む。「HTTP 応答を返した後」は発火が要求の寿命の外に出て、要求に紐づかない `tick()` の扱いを
別に決める必要がある。

「commit 時」なら stream は常にメモリと一致し、**劣化中も生かしている読み取りがメモリの状態を
返すのと揃う**。10.5 で決めた「応答は失敗・メモリには残る」という非対称を、stream もそのまま
見せるだけになる。劣化後は変更が断られ `tick()` も止まるので、流れ続けることは無い。

代償は、HTTP 応答より先にイベントが届き得ること。公式も HTTP と stream の順序を保証しておらず、
利用側はもともとこれに耐える必要がある（`docs/fidelity.md` の「private stream と永続化の失敗」節）。

### 16.2 派生して決めた点

| 論点 | 決定 |
|---|---|
| 層 | 新規 `src/stream/`（`events.ts` = 状態の差 → メッセージ、`hub.ts` = 配信と `DeliveryPolicy`）。`SessionStore` は購読の口（`onStateChange()`）だけを持ち、stream を知らない。**`store → stream` / `store → routes` の辺は作らない**（11.1 の層の記録を崩さない） |
| 整形 | `src/routes/format.ts` に `formatStreamOrder()` / `formatAsset()` / `formatAssetUpdate()` を足した。`spot_trade` は `formatTrade()` をそのまま使う（14.1 の (2) のとおり）。資産は `formatAssets()` の出力を写すだけにして、REST と stream で金額の文字列化が分かれないようにした |
| 注文ペイロードの差（14.1 の (1)） | `executed_at` は常に出し、値は最も遅い約定時刻（`POST /_control/tick` は過去の足を流し直せるので、記録順と時刻順が食い違い得る）、約定が無ければ `0`（**当初は約定があるときだけ出していた**。16.5 で英日の表と突き合わせて直した）。`is_just_triggered` は常に `false`。14.1 の (2) の「分け方は未決」は、**`formatOrder()` を土台にして 2 つを足す**形で決めた |
| `asset_update` のキー（3.4 で保留） | **既定 camelCase、`BITBANK_MOCK_STREAM_ASSET_KEYS=snake` で snake_case。** 公式が割れていて実測もできないので、利用側が両方の綴りで試せることを優先した。既定を camelCase にした推測は `docs/fidelity.md` の同名の節 |
| `params` の要素数 | 常に 1。公式の例のコードが `params[0]` しか読まないため |
| 並べ方 | 1 回の変化の中は注文 → 約定 → 資産。公式は順序を保証しないので、利用側に依存させない |
| 成行 | `spot_order_new` が 1 通（`FULLY_FILLED`）。1 回の変化につき 1 注文 1 通で、**状態に一度も現れていない `UNFILLED` を作って送ることはしない**。公式の `spot_order_new` の注記も、新規の通知が終端の状態で届くことを想定している |
| reset | イベントを送らず、全接続を close code 1012 で閉じる。注文 id が 1 から配り直されるので、差分を送ると利用側の手元で前後の注文が混ざる。`SessionStore.reset()` を足して購読者に `kind: "reset"` で伝える（差から reset を推測させない） |
| `GET /v1/user/subscribe` | ダミーの固定値を返す。**`store.tick()` を呼ばない唯一の互換ルート**で、11.2 の決定 11 の例外になる。状態を読まないうえ、tick すると再接続の手順（subscribe → 接続）の途中で取りこぼしの窓を作るため。`tests/routes/tick.test.ts` の許可リスト（`NO_STATE_ROUTES`）に理由つきで載せ、状態を読み始めたら落ちるようにした |
| 劣化中 | `GET /v1/user/subscribe` と `GET /_stream/private` を読み取り経路（`READ_ROUTES`）に入れた。接続は断らないが、状態が動かないので何も流れない |
| 接続時のスナップショット | 送らない。公式の PubNub も購読前の変化を届けない |
| クライアントからの入力 | 読まない。1 フレームを 1024 バイトに絞る（`ws` の `maxPayload`） |
| upgrade でない GET | 426 + `{"error":"UPGRADE_REQUIRED"}`。`@fastify/websocket` の既定は本文の無い 404 で、口が無いように見える |
| 障害注入 | `DeliveryPolicy` を `buildServer()` の引数で受ける（既定は恒等写像）。**外から切り替える口（env や `/_control/`）は作らない**——3.4 のとおり Plan B で決める（→ 17 節で Plan A へ前倒しした） |
| 依存 | `@fastify/websocket`（Fastify 5 対応の 11 系。`ws` に依存）を dependencies に、テストのクライアント用に `ws` と `@types/ws` を devDependencies に足した。追加後の `npm audit --audit-level=high` は 0 件 |

### 16.3 テスト

| ファイル | 見るもの |
|---|---|
| `tests/stream/events.test.ts` | 状態の差 → メッセージ。発注・部分約定・成行・取消・一括取消・時計だけの差し替え・消えた資産。形は `tests/routes/official-fields.ts` に写した公式の表（stream の注文、`spot_trade`、`asset_update` の 2 つの綴り）と突き合わせる |
| `tests/stream/hub.test.ts` | 配信・配信方針・reset で閉じる・送れない購読者を外す・例外を外へ出さない |
| `tests/routes/private-stream.test.ts` | WebSocket の口。`injectWS()` と、実際に listen したサーバへの `ws` クライアントの両方 |
| `tests/routes/subscribe.test.ts` | 応答の形と、tick を通らないこと |
| `tests/scenarios/private-stream.test.ts` | 3.4 の受入条件（2 本発注・1 本を control で約定・1 本を取消）と、stream が最後に伝えた見え方が REST と一致すること。一括取消、成行、market の読み取りが起こす約定、書き出しの失敗 |
| `tests/store/session.test.ts` | 状態の差し替えの通知（`commit()` / `reset()` / `tick()`、購読者の例外） |

**待ち方は時間ではなく ping / pong にした**（`tests/routes/helpers.ts` の `streamRecorder()`）。
1 本の接続の上でフレームの順序は崩れず、サーバはメッセージを状態の差し替えと同じ同期の流れで
書くので、HTTP の応答を待ってから pong を待てば、その要求が起こしたメッセージはすべて届いている。
これで「何も届かないこと」も時間に頼らずに確かめられる。

実装中に踏んだ罠を 2 つ記録する。**サーバへ WebSocket で繋ぐテストを書くなら同じ 2 点を踏む。**

- **`injectWS()` は `ready()` を待たない。** 起動前に呼ぶと応答が返らず固まる。先に `inject()` した
  （＝起動させた）テストだけが通るので原因が見えにくかった。`connectStream()` が `ready()` を
  待ってから繋ぐ
- **`injectWS()` の接続は、クライアントから閉じてもサーバ側が閉じない**（メモリ上の duplex で、
  ws の閉じる手順が相手の切断待ちのまま残る）。「閉じたら購読者から外れる」は実際に listen した
  サーバで確かめている

### 16.4 入れないもの

- **障害注入を外から切り替える口**（16.2）。Plan B（→ 17 節で Plan A へ前倒しし、PR B で
  `/_control/stream/hold` / `held` / `release` の保留・再送として入れた。`DeliveryPolicy` を外から選ぶ口は
  作っていない——1 回の変化の中しか並べ替えられず、変化をまたいだ入れ替えが作れないため。17.2 の要判断事項 18。
  挙動は `docs/fidelity.md` の「private stream の保留・再送」節）
- **`market` モードで裏から足を見張る仕組み**（「誰も叩かなければ届かない」の解消）。外向きの取得の
  頻度が増えるので、15.2 の要判断事項 16（取得頻度）と合わせて決める
- **`spot_order_invalidation`**（14.1 の (1)）。発生条件が起こり得ない
- **PubNub のプロトコル互換**（3.4 の決定のまま）

### 16.5 公式ドキュメントとの整合性の確認（2026-09-27）

実装の直後に、送るメッセージを公式の表と**英日の両方で**突き合わせた。

**公式の版は動いていない。** `bitbankinc/bitbank-api-docs` の `master` の先頭は、このモックが固定している
`0badd680`（2026-09-11）のままだった。REST の側の突き合わせ（`docs/fidelity.md` の対応表と
`tests/routes/official-fields.ts`）はそのまま有効である。

**やり方。** 英日の `private-stream*.md` から `asset_update` / `spot_order_new` / `spot_trade` /
`spot_order_invalidation` の表を行ごとに抜き出して英日を比べ、次にモックが実際に作るメッセージ
（指値の発注・部分約定・部分約定後の取消・売りの発注・全量約定・成行）の全キーと型を、英日それぞれの表に
当てた。目で読み比べると見落とすので、**表の行を機械的に突き合わせた**。

**分かったこと。**

| 項目 | 結果 |
|---|---|
| 表に無いキー | **1 つも出していない**（英日とも） |
| 英日の表の食い違い | `spot_order_new` で 5 行（`canceled_at` / `price` / `remaining_amount` / `start_amount` / `expire_at`）、`spot_trade` で 3 行（`position_side` / `profit_loss` / `interest` が英 `\| undefined`・日 `\| null`）。`asset_update` と `spot_order_invalidation` の表は英日で一致（表と例の食い違いは既知） |
| 英日のどちらにも合わない値 | **`executed_at` を約定の無い注文で省いていた 1 件だけ。** 英日とも `number` で省略を許していない。**直した**（常に出し、約定が無ければ `0`） |
| 残る食い違い | 英日の表が割れている 8 行だけで、どれもモックの値は片方の言語版と REST の表（英日とも）に合う。どちらかを正に選ばず、`docs/fidelity.md` の「private stream の注文ペイロード」節と「信用取引・逆指値の項目」節に表として記録した |

**14.1 の (2) の記述を 1 つ補う。** 同項は `spot_trade` の信用取引の 3 フィールドを「公式が `| undefined` と
定義する」と書いたが、**これは英語版だけの話で、日本語版は `| null`** である。14.1 は調査の記録なので本文は
書き換えず、ここに残す。16.2 の実装（キーごと出さない）は REST の表（英日とも `| undefined`）と英語版に
揃えたもので、変えていない。

**入れなかったもの。** 英日の表を CI で突き合わせる検査は足していない。公式の版を固定している限り表は
動かず、固定する版を上げるときに一度流せば足りるためである（今回は `master` が固定の版と同じだったので上げていない）。

---

## 17. 利用側の Plan A 向けの実験の口（2026-09-30）

利用側は Plan A で、private stream が順序を保証しないこと（`docs/fidelity.md` の「private stream の順序」節）と、
時刻で区切る窓に耐える実装を、このモックの上で検証する。そのためにモックへ求めているのは次の 3 つである。

1. private stream で**重複と順序の入れ替え**を起こす手段
2. 注文・約定・取消の**時刻を制御できる時計**
3. 注文を **`REJECTED`** にする手段

本節は、これに合わせて Plan A の範囲を変える理由（17.1）と、実装の前に決めることを要判断事項 17 以降として
記録する（17.2）。**要判断事項は 2026-09-30 にすべて決めた**（各項目の「決定」。22 と 24 は案を一部変えた）。PR の分け方は 17.3、
入れないものは 17.4、決定 24〜28 が PR C2 に送っていた細部を C2 で決めた記録は 17.5 にある。**`src/` と `tests/` は 1 行も触っていない。** README と `docs/fidelity.md` は、
それぞれの実装 PR が挙動と同時に直す。

### 17.1 範囲を変える理由

**3 つとも、これまでの計画は Plan A の外に置いていた。**

| 求めるもの | これまでの置き場所 |
|---|---|
| (1) 重複・順序入替 | 3.4 は `DeliveryPolicy` を「プラン A では恒等写像。プラン B で重複・順序入替・欠落を差し込む」とし、16.2 の「障害注入」の行と 16.4 は**障害注入を外から切り替える口**を Plan B に置いた。README の「非目標（Plan A）」にも「障害注入（private stream の重複・順序入替・欠落を含む）」が載っている |
| (2) 時計 | `/_control/clock` は `lastTickAt` を動かすが、**互換ルートが記録する時刻は実時刻のまま**である。`ordered_at` と `canceled_at` は要求を受けた時刻で、`/_control/` の fill の約定時刻も同じ。動かせるのは `/_control/tick` の足の `timestamp` から決まる約定時刻だけで、それも実時刻 + 24 時間まで（`docs/fidelity.md` の「control の時計」節） |
| (3) `REJECTED` | 3.1 は `rejectOrder()` を「プラン A では到達させない。関数だけ用意」とした。今も呼び出し元はテストだけである |

**利用側が Plan A で stream の重複・順序入替への耐性を検証するため、これを Plan A に前倒しする。**
利用側が検証する規則と、それを踏むのに要るものの対応は次のとおり。

| 利用側の規則 | 踏むのに要るもの | 今のモック | PR |
|---|---|---|---|
| 単調性（注文ごとに `executed_amount` の最大値を持ち、それより小さいスナップショットを捨てる） | 古いスナップショットが新しいものの後に届くこと、同じものが 2 度届くこと | 起こせない（常に発生順・重複なし） | B |
| 終端の優先（終端の後に届いた非終端のスナップショットを捨てる。終端は `FULLY_FILLED` / `CANCELED_UNFILLED` / `CANCELED_PARTIALLY_FILLED` / `REJECTED`） | 上に加えて、`REJECTED` に到達すること | 入れ替えを起こせず、`REJECTED` へ到達する口も無い | B・A |
| fail-closed（一定時間状態を確認できないと新規の発注を止め、REST の照合が成功したら解除する） | stream が届かない状態と、その間も通る REST の照合 | 照合（`orders_info`）はある。stream だけを止める口が無い | B |
| 再同期（再起動したら未決の注文を照合してから受付を再開する） | 利用側が止まっている間に進む状態変化 | **既にある**（manual モードで `/_control/` から起こす） | — |
| 時間窓（有効期限。境界の時刻は有効に含む。JST の暦日で区切る窓） | 注文・約定・取消の時刻を狙った値に置けること | 上の表の (2) のとおり、置けない | C1・C2 |

**`/_control/` を広げる基準にも照らした。** 13.2 はサーキットブレーカーについて「プラン A で誰も踏まない
条件のために制御面を広げない」とした。今回の 3 つは利用側が Plan A で踏むので、この基準には当たらない。

**これまでの記述は書き換えない。** 3.1・3.4・16.2・16.4 は当時の決定の記録として残し、本節への参照だけを
足した（14.2 を 16.1 の決定の後も書き換えずに残したのと同じ扱い）。README の「非目標（Plan A）」と
`docs/fidelity.md`（「private stream の順序」節など）は、挙動が変わる PR B で直す。

### 17.2 要判断事項（15.2 の続き。**2026-09-30 に決定**）

番号は 15.2 の続きで 17 から振る。**15 と 16（足の取得）は未決定のまま残し、本節では扱わない。**

**決定は各項目の末尾の「決定」にある。** 論点・選択肢・代償・案は決める前に置いた記録として書き換えず、
決定で片付いた箇所に参照だけを足した（14.2 と同じ扱い）。17 節が PR B / C2 に送っていた細部も、決定の中で
決めた。**22 と 24 は案を一部変えた。**

#### 17. `REJECTED` にした注文を private stream で送るか（PR A）

PR A は `POST /_control/orders/:order_id/reject` を足し、`rejectOrder()`（`src/engine/transitions.ts`）で
注文を `REJECTED` にする（受けるのは `UNFILLED` と `INACTIVE` だけ）。stream のイベントは状態の差から作るので
（16.1 の決定 13）、**何もしなければ `status: "REJECTED"` の `spot_order` が 1 通と、拘束が解けた資産の
`asset_update` が流れる**。一方、**公式の stream の `status` の列挙は 6 値で、`REJECTED` を含まない**
（`private-stream.md:130` / `private-stream_JP.md:131`。`docs/fidelity.md` の「注文状態」節の表）。

| 選択肢 | 代償 |
|---|---|
| 送る（差から作るまま） | 特例が要らない。REST の照会と stream が同じ状態を見せる。ただし**公式の stream の列挙に無い値を送る**ので、推測として記録する |
| 送らない | 公式の列挙には合う。ただし `src/stream/events.ts` に status を見て落とす**特例が要る**（「状態の差から作る」の唯一の例外になる）。照会には `REJECTED` が出るのに stream は黙るので、16.1 で「このモックが一番避けたい食い違い」とした形になる。拘束が解けた `asset_update` だけは流すのかも別に決めることになる。利用側は `REJECTED` での「終端の優先」を REST の照合でしか踏めない |
| `spot_order_invalidation` で送る | 「注文が無効になった」通知としては近く見える。ただし `docs/fidelity.md` の同名の節が **`rejectOrder()` を流用しない**と決めている（`REJECTED` は注文の状態で、資産不足による無効化の通知ではない）。wire 形も公式内で食い違っている |

**案（推奨）: 送る。** 特例を作らず、REST と stream の見え方を揃える。**公式の stream の列挙（6 値）に
`REJECTED` は無いので、推測として `docs/fidelity.md` に記録する**（「private stream の注文ペイロード」節。
同節の「互換ルートと `/_control/` から `REJECTED` へ到達する経路は無い」も PR A で書き換える）。

**決定**: **送る**（2026-09-30、案のとおり）。公式の stream の列挙（6 値）に `REJECTED` が無いことは、推測として
PR A で `docs/fidelity.md` に書く。

#### 18. 重複・順序入替を起こす仕組み（PR B）

利用側の「単調性」と「終端の優先」を踏むには、**状態変化をまたいだ入れ替え**——`FULLY_FILLED` の
`spot_order` の後に、それより前の部分約定で作った `PARTIALLY_FILLED` の `spot_order` が届く——が要る。
既存の差し込み口 `DeliveryPolicy`（`src/stream/hub.ts`）は、**1 回の状態の差し替えで作ったメッセージの列を
受けて列を返す関数**で、呼ばれるのも差し替え 1 回につき 1 回である。前の変化のメッセージは呼ばれた時点で
送り終えているので、**この形では変化をまたいで並べ替えられない**。

| 選択肢 | 代償 |
|---|---|
| `DeliveryPolicy` を外から選べるようにする（env や `/_control/` で「重複」「逆順」「落とす」を切り替える） | 差し込み口は既にある。ただし上のとおり **1 回の変化の中でしか並べ替えられない**。部分約定と全量約定は別の変化なので、要る入れ替えが作れない |
| `DeliveryPolicy` に状態を持たせ、変化をまたいで溜める | 関数の型は変えずに済む。ただし溜めたものを送り出す契機が関数の中に無く（次の変化が来るまで呼ばれない）、結局、送り出す口が外に要る |
| 保留・再送（hold / held / release） | hold で以後のメッセージを送らずに溜め、held で溜めたものを番号つきで見せ、release で**どれを・どの順で・何回**送るかを番号の並びで指定する。重複（同じ番号を 2 回）・順序入替（並べ替え）・欠落（指定しない）が 1 つの仕組みで作れ、**指定したとおりにしか動かないので再現できる**。代償は、`/_control/` に口が 3 つ増えることと、溜めたものが `PaperState` の外（メモリ）にあって再起動で消えること |

**案（推奨）: 保留・再送（hold / held / release）。** 口の形（パス・本文・番号の振り方）は PR B で決め、
`docs/fidelity.md` に書く。**PR B で決める必要がある点が 1 つある**: `PrivateStreamHub` は購読者がいないと
メッセージを作らないので、そのままでは**購読者が 0 人の間は何も溜まらない**（利用側の再起動の間に起きた
変化を、繋ぎ直した後に届ける使い方ができない。→ 決定で、保留中は 0 人でも溜めることにした）。

**決定**: **保留・再送（hold / held / release）**（2026-09-30、案のとおり）。**保留中は、購読者が 0 人でも
メッセージを作って溜める。** 利用側が再起動している間に起きた変化を、繋ぎ直した後に届けられるようにするため。
保留していないときは今のまま、購読者がいなければ何も作らない。

#### 19. 注入の範囲（PR B）

| 選択肢 | 代償 |
|---|---|
| 重複・順序入替・欠落（保留・再送で作れるものだけ） | 欠落は release で指定しないだけなので、**同じ仕組みでそのまま付く**。「単調性」「終端の優先」「fail-closed」をそれぞれ踏める |
| 上に加えて、時間で遅らせる（メッセージごとに N ミリ秒） | 本物の到着の揺れには近い。ただし**テストが時間に依存する**（stream のテストは時間ではなく ping / pong で待つ形にしてある。16.3）。遅延が生む入れ替えは、保留・再送で同じものを作れる |
| 上に加えて、乱数で注入する（確率 p で重複・欠落） | 手で組まない組み合わせを踏める。ただし**再現できない**。種を固定しても、状態変化の数が変わるたびに結果が変わる。組み立てたシナリオで確かめるという `/_control/` の使い方と合わない |

**案（推奨）: 重複・順序入替・欠落。** 時間で遅らせる注入と、乱数での注入は入れない（17.4）。

**決定**: **重複・順序入替・欠落**（2026-09-30、案のとおり）。時間で遅らせる注入と、乱数での注入は入れない（17.4）。

#### 20. 接続ごとに変えるか（PR B）

| 選択肢 | 代償 |
|---|---|
| 変えない（全接続に同じものを送る） | hub の今の形（外側をメッセージ、内側を購読者にして、JSON 化は 1 通 1 回）のまま。接続を指す名前を `/_control/` に出さずに済む。代償は、接続ごとに違う見え方を作れないこと。また release はその時点で繋がっている全員に送るので、**保留した後に繋いだ接続にも、繋ぐ前の変化のメッセージが届く**（「接続した後の変化だけが届く」という既存の約束の例外になる。`docs/fidelity.md` の「private stream」節） |
| 変える（接続ごとに保留・再送） | 複数の接続を持つ構成（2 つのプロセスが別々に購読するなど）で、片方にだけ届かない状態を試せる。ただし接続に id を振って `/_control/` から指す口が要り、溜める場所も接続の数だけになる |

**案（推奨）: 変えない**（全員に同じものを送る）。

**決定**: **接続ごとには変えない**（2026-09-30、案のとおり）。release は、その時点で繋がっている全員に送る。
**保留の後に繋いだ接続にも、繋ぐ前の変化が届く。** これは「接続した後の変化だけが届く」という約束の例外として、
PR B で `docs/fidelity.md` に書く。

#### 21. 保留中に reset したとき（PR B）

`POST /_control/reset` は注文 id を 1 から配り直し、private stream の接続をすべて close code `1012` で閉じる
（16.2、`docs/fidelity.md` の「private stream と状態の初期化」節）。**溜めてあるのは reset の前の注文の
メッセージ**である。

| 選択肢 | 代償 |
|---|---|
| 捨てる | reset で接続を閉じる理由（前の注文 1 と新しい注文 1 を混ぜない）がそのまま効く。代償は、reset をまたいで古いメッセージを届けられないこと |
| 残す（reset の後にも release できる） | 前のシナリオの `order_id: 1` が、新しいシナリオの `order_id: 1` として届く。**reset で接続を閉じるようにした理由を裏から崩す** |
| 保留中は reset を断る（409） | 混ざらない。ただし前の実験で保留を解き忘れていると、シナリオの冒頭の reset（`examples/scenario-plan-a.sh` など）で止まる |

**案（推奨）: 溜めたものを捨てる。** 保留そのもの（reset の後の変化も溜め続けるか）を解くかは PR B で決める（→ 決定で、解くことにした）。

**決定**: **溜めたものを捨てる**（2026-09-30、案のとおり）。**あわせて保留も解除し、通常の配信に戻す。**
前の実験で解き忘れた保留が、次のシナリオのイベントを黙って飲み込まないようにするため。

#### 22. 溜める量（PR B）

| 選択肢 | 代償 |
|---|---|
| 上限なし | 一番簡単。ただし解き忘れるとメモリが増え続ける（market モードでは読み取りのたびに約定が起こり得るので、何もしていなくても溜まる。16.1 の決定 13） |
| 上限を設け、超えたら古いもの（か新しいもの）を捨てる | 断らずに済む。ただし**意図しない欠落が黙って起きる**——確かめようとしている現象そのものを、利用側の知らないところで作る |
| 上限を設け、超えたら 409 で断る | 黙って落とさない。ただし **409 を返せるのは `/_control/` の要求だけ**である（互換ルートは封筒に包むので HTTP 409 を返せない）。また 1 回の変化が作るメッセージの数は変化の前には分からないので、判定は「溜めた数が上限に達していたら、次の変化を起こす要求を断る」形になり、上限を 1 変化ぶん超え得る |

**案（推奨）: 上限を設け、超えたら 409 で断る。** 上限の値と、**互換ルートの発注・取消や market モードの
tick が溢れさせるときの扱い**は PR B で決める（→ 扱いは決定で案から変えた。値は PR B で決める）。

**決定**: **上限を設ける**（2026-09-30）。**案から変える点**: 上限に達した後の変化は、**どの経路が起こしたもの
でも溜めない**。代わりに「溢れた」印と落とした件数を残し（held にも出す）、**以後の release を 409 で断る**。
**状態を変える要求そのものは断らない。** 抜け出すのは reset である（21 の決定のとおり、溜めたものを捨てて
保留を解く）。

理由: 互換ルートと market モードの tick は 409 を返せない。案の「超えたら 409 で断る」は `/_control/` の要求に
しか効かず、それ以外の経路が溢れさせたときの扱いが残っていた。経路によって扱いを分けず、実験する側に必ず
見える形 1 つにそろえる。**上限の値は PR B で決める。**

#### 23. 書き出し失敗後の劣化中に hold / release を通すか（PR B）

書き出しに失敗した後（`PERSIST_DEGRADED`。10.5）は、状態を変える要求を断る。どの口を通すかは
`src/server/degraded.ts` の `READ_ROUTES` / `MUTATING_ROUTES` で決まり、**どちらにも載っていない口があると
サーバが起動しない**（`assertRouteClassified()`）。hold / held / release は `PaperState` を変えず、hub の
メモリだけを変える。

| 選択肢 | 代償 |
|---|---|
| 通す | **劣化の前に溜めたものを release で取り出せる**（劣化の引き金になった `70001` の要求のイベントも含む。`docs/fidelity.md` の「private stream と永続化の失敗」節）。溜めたものはメモリにしか無く再起動で消えるので、断るとその回の stream の実験を回収できない。劣化中は状態が動かないので、新しく溜まるものは無い。代償は、hold / release が「読み取り」ではないこと——`READ_ROUTES` に載せると名前と中身がずれる。3 つ目の分類を足すか、`READ_ROUTES` の意味を「`PaperState` を変えない」に書き直すかは PR B で決める（→ 決定で、3 つ目の分類を足すことにした） |
| 断る（503 `PERSIST_DEGRADED`） | 「劣化中は読むだけ」の形が素直に保てる。代償は、劣化の前に溜めたものが取り出せないまま、復帰の手順（ディスクを直す → 読み出す → 再起動。10.5）で消えること |

**案（推奨）: 通す**（`PaperState` を変えないため）。

**決定**: **劣化中も通す**（2026-09-30、案のとおり）。**`READ_ROUTES` の意味は書き換えない。**
「状態ファイルに書かない control の口」という **3 つ目の分類**を `src/server/degraded.ts` に足し、劣化中も
これを通す。`assertRouteClassified()` もこの分類を受け付けるようにする（どの分類にも載っていない口では、
今までどおり起動しない）。

#### 24. 仮想時計を有効にする条件（PR C2）

仮想時計は、互換ルートが記録する時刻（`ordered_at` / `executed_at` / `canceled_at`）を実時刻から切り離す。
**黙って有効になると、実時刻のつもりの利用者の記録が狂う。** また market モードは実時刻の窓で公開 API の
足を取るので（15.1 の (1)）、時計を実時刻から離すと取得の窓が意味を失う。

| 選択肢 | 代償 |
|---|---|
| env で明示したときだけ（例: `BITBANK_MOCK_CLOCK=virtual`）、manual モードに限る | 既定の挙動は変わらない。代償は env が 1 つ増えること。空文字と未知の値は既定（実時刻）に落とす（`src/server/config.ts` の他の env と同じ規則） |
| `BITBANK_MOCK_CONTROL=1` なら常に仮想 | env が増えない。代償は、**control を使う既存の利用者の記録の時刻が変わる**こと（既定の変更）。9 節の決定 1（control 有効時は manual が既定）と同じ連動だが、こちらは記録される時刻そのものを変える |
| `/_control/` から実行中に切り替える | 再起動が要らない。代償は、切り替えの前後で記録の時刻の基準が混ざること。どちらの時計で記録したかを状態ファイルに残さないと、再起動の後に分からなくなる（スキーマの変更） |

**案（推奨）: env（例: `BITBANK_MOCK_CLOCK=virtual`）で明示したときだけ、manual モードでのみ有効にする。**

**あわせて決めること: market モードと同時に指定されたとき。** market になるのは
`BITBANK_MOCK_FILL_MODE=market` を明示したときと、control を有効にしていないとき（既定が market。
9 節の決定 1）の 2 通りで、後者は時計を動かす口（`/_control/clock`）も無い。

| 選択肢 | 代償 |
|---|---|
| 起動を拒否する | 矛盾した設定で実験が始まらない。壊れた状態ファイル・未分類のルート・状態ファイルのロックで起動しないのと同じ姿勢。代償は、**env の組み合わせで起動を断る初めての経路**になること |
| warn を出して仮想時計を無効にする | 起動は止まらない。代償は、warn を見落とすと**時計を進めたつもりで実時刻が記録される**こと。確かめようとしている時間窓の実験が、黙って別の条件で走る |
| warn を出して manual に落とす | 同上。market を明示した意図が黙って消える |

**案（推奨）: 起動を拒否する。**

**決定**: **env で明示したときだけ有効にする**（2026-09-30、案のとおり）。**案に足す点**: 有効にするのは
**`BITBANK_MOCK_CONTROL=1` かつ manual モードのときだけ**で、それ以外（market モード、または control 無効）と
同時に指定されたら**起動を拒否する**。control が無いと、時計を動かす口が無いため。

#### 25. 時計の値の置き場（PR C2）

| 選択肢 | 代償 |
|---|---|
| `lastTickAt` を使い回す | **スキーマは v3 のまま**で、状態ファイルに残るので**再起動しても続く**（利用側の「再同期」を仮想時刻のまま試せる）。manual モードで `lastTickAt` を書くのは `/_control/tick` と `/_control/clock`、それに状態を作り直す `/_control/reset`（`freshState()` が実時刻を入れる）だけで、`SessionStore.tick()` は manual では先頭で返る。代償は、1 つのフィールドが「最後に tick した時刻」と「いまの時刻」を兼ねること。`/_control/tick` は 1 回で 60 秒以上進める（`docs/fidelity.md` の「control の時計」節）ので、**tick を打つと仮想時計も進む**。reset すると仮想時計は実時刻に戻る |
| `PaperState` にフィールドを足す（例: `virtualNow`） | 意味が分かれる。代償は、版を v4 に上げて移行を書くこと（v2 → v3 と同じ手当て。3.1）。不変量の前提の検査（`docs/fidelity.md` の「不変量を破る状態ファイル」節）も見直す |
| メモリだけに持つ | スキーマに触れない。代償は、**再起動で実時刻に戻る**こと。仮想時計を先へ進めていれば記録済みの時刻より前へ飛び、「再同期」の実験で時計が巻き戻る |

**案（推奨）: `lastTickAt` を使い回す。** manual モードで `lastTickAt` を動かすのは `/_control/tick` と
`/_control/clock` だけなので（reset は状態ごと作り直す）、そのまま使える。スキーマは v3 のままで、
再起動しても続く。

**決定**: **`lastTickAt` を使い回す**（2026-09-30、案のとおり）。スキーマは v3 のまま。`/_control/tick` を打つと
時計が 60 秒以上進むこと、reset で時計が実時刻に戻ることは**受け入れ**、PR C2 で `docs/fidelity.md` に書く。

#### 26. 時計の進み方（PR C2）

| 選択肢 | 代償 |
|---|---|
| 自分では進まない（`/_control/clock` で動かす） | **境界の時刻をミリ秒単位で狙える**（利用側の有効期限は境界の時刻を有効に含むので、境界ちょうどと 1 ミリ秒後を分けて踏む必要がある）。今の `/_control/clock` は時刻の絶対値しか受けないので、「N ミリ秒進める」指定を足す。代償は、時計を進めない限り**続けて出した注文の `ordered_at` が同じ値になる**こと（前後は `order_id` で分かる）。また 25 のとおり、「自分では進まない」は「`/_control/clock` と `/_control/tick` でしか進まない」の意味になる |
| 実時刻と同じ速さで進む（実時刻 + ずらし幅） | 要求ごとに違う時刻が記録される。代償は、**境界ちょうどを狙えない**こと（要求が届くまでの時間だけずれる）。テストが時間に依存する |
| 倍速で進む | 長い窓（暦日）を短い実時間で通せる。代償は上と同じで、ずれが倍率のぶん大きくなる |

**案（推奨）: 自分では進まない。** `/_control/clock` に「N ミリ秒進める」指定を足す。

**決定**: **時計は自分では進まない**（2026-09-30、案のとおり）。`/_control/clock` に「N ミリ秒進める」指定を足す。
同じ時刻の記録が並ぶので、時刻で絞り込む応答（`trade_history`、`active_orders` の `since` / `end`）で、
**同じ時刻どうしが id 順に並ぶことを PR C2 で確かめる**。どちらの応答も時刻では並べ替えず生成順のまま返すので
（`docs/fidelity.md` の「active_orders の絞り込み」節・「trade_history の絞り込み」節）、今の実装のままでも
id 順（`trade_history` の既定の `desc` なら id の逆順）になるはずである。

#### 27. 24 時間の上限（PR C2）

`/_control/tick` と `/_control/clock` は、時計を**実時刻より 24 時間より先へ進めない**（`MAX_CLOCK_AHEAD_MS`。
`docs/fidelity.md` の「control の時計」節）。`4e12`（西暦 2096）のような打ち間違いを止めるための上限で、
幅は `runTick` が 1 回で遡る上限と同じ。仮想時計で JST の暦日の窓を何日ぶんも進めると、この上限に当たる。

| 選択肢 | 代償 |
|---|---|
| 維持する | 打ち間違いの保護がそのまま残る。代償は、**実時刻から 24 時間より先を踏めない**こと。暦日の窓を 2 つ以上先へ進める実験ができない |
| 仮想モードでは外し、1 回で進める幅に上限を置く | 何日でも先へ進められ、打ち間違いは今と同じく 1 回の要求で断れる。代償は、上限の基準が「実時刻から」から「いまの仮想時刻から」に変わり、繰り返せば際限なく進むこと（意図した操作なので止めない）。足の `timestamp` の上限（`isValidCandleTimestamp`。`docs/fidelity.md` の「control の fill / tick 検証」節）はそのまま効く |
| 仮想モードでは外すだけ | 一番簡単。代償は、打ち間違いがそのまま時計になり、以後の記録がすべてその時刻になること（28 の案なら、戻すには reset しかない） |

**案（推奨）: 仮想モードでは外し、代わりに 1 回で進める幅に上限を置く。** 幅は PR C2 で決める（→ 決定で、24 時間にした）。

**決定**: **仮想モードでは 24 時間の上限を外し、1 回で進める幅に上限を置く**（2026-09-30、案のとおり）。
幅は今の `MAX_CLOCK_AHEAD_MS`（24 時間）を「1 回で進める幅」として使い回す。

#### 28. 巻き戻し（PR C2）

今の `/_control/clock` は**戻す向きにも使える**（過去の足を流し直す前に時計を戻す用途。`docs/fidelity.md` の
「control の時計」節）。仮想時計では時計が記録の時刻そのものになるので、戻すと**後から出した注文の
`ordered_at` が、先に起きた約定の `executed_at` より前になる**という記録ができる。6 本の不変量は時刻の順を
見ないので状態は壊れないが、時刻で窓を切る利用側の集計は前提を失う。

| 選択肢 | 代償 |
|---|---|
| 自由に戻せる（今のまま） | 過去の足を今どおり流し直せる。代償は、上のような順の崩れた記録が作れてしまうこと |
| 既存の記録より前へは戻せない（戻したいときは reset） | 記録の時刻の順が崩れない。記録より後であれば戻せる。代償は、どの時刻を「記録」と見なすか（`orderedAt` / `executedAt` / `canceledAt`。`updatedAt` を含めるか）を決め、戻すたびに全記録を見ること。過去の足を流し直せるのは、最後の記録より後の区間だけになる |
| 一切戻せない（単調） | 一番簡単で、記録の順も崩れない。代償は、記録の無い区間へも戻せず、時計を進めすぎたら reset するしかないこと |

**案（推奨）: 仮想モードでは、既存の記録より前の時刻へ戻すのを断る。** 戻したいときは reset する。

**決定**: **既存の記録より前の時刻へは戻せない**（2026-09-30、案のとおり）。戻したいときは reset する。
「記録」とみなすのは、**注文の `orderedAt` / `canceledAt` と、約定（trade）の `executedAt`**。`updatedAt` と
`lastTickAt` は含めない。注文の約定時刻（stream の `executed_at`）は `OrderRecord` には無く、trade の
`executedAt` から作るので（16.2）、約定の側で数える。

### 17.3 PR の一覧と依存関係

| PR | 中身 | 前提となる PR | 対応する要判断事項 |
|---|---|---|---|
| 0 | 計画: 本節を足す（範囲の変更と、要判断事項 17 以降） | なし | —（17〜28 を記録する） |
| A | (3) `POST /_control/orders/:order_id/reject` | なし | 17 |
| B | (1) private stream の保留・再送 | 0 | 18〜23 |
| C1 | (2) の下準備: 時刻の出どころを `store.now()` に一本化する（挙動は変えない） | なし | なし |
| C2 | (2) 仮想時計 | 0、C1 | 24〜28 |

- **A が 0 を待たないのは**、要判断事項 17 が「送る」なので、配信の側に手を入れずに済むからである（イベントは
  状態の差から作る。2026-09-30 に案のとおり決定）
- **C1 が要るのは**、実時刻を読む箇所が散っているためである——`nowIso()`（`src/engine/state.ts`）、
  `new Date()`（`src/routes/create-order.ts`・`src/routes/cancel-order.ts`・`src/routes/control.ts` の fill）、
  `Date.now()`（`src/routes/control.ts` の tick / clock、`SessionStore.tick()` / `getLatestPrice()` の既定の
  引数）。C1 でこれを `store.now()` の 1 か所に寄せ、C2 はその中身だけを仮想時計に差し替える
- **README と `docs/fidelity.md` は各実装 PR が直す。** 挙動を変える PR（A・B・C2）は、`docs/fidelity.md` の
  「v0.1.0 からの改訂」に 1 行ずつ足す。0 と C1 は挙動を変えない

### 17.4 入れないもの（いずれも Plan B 以降）

- **時間で遅らせる注入・乱数での注入・接続ごとの注入**（要判断事項 19・20 の決定）
- **REST 側の障害注入**（応答が返らない・5xx・429）。利用側が Plan A で求める 3 つに入っていない。レート制限は
  `docs/fidelity.md` の「レート制限」節のとおり未実装のまま（→ 2026-09-30 に 18 節で Plan A へ前倒しした。
  要判断事項 29〜34・36。回数を数えるレート制限は要判断事項 32）
- **板と成行の拡張**。同上

### 17.5 PR C2 で決めたこと（仮想時計の細部）

17.2 の決定 24〜28 が PR C2 に送っていた細部を、PR C2 で次のとおり決めた。**17.2 の本文は書き換えない**
（決める前の記録として残す）。挙動の正は `docs/fidelity.md` の「仮想時計」節で、ここは索引である。

| 論点 | 決めたこと | 理由 |
|---|---|---|
| tick の約定が時計より先に残る（実時刻モードは約定が「足の `timestamp` + 1 分」、時計が `max(前進の下限, timestamp)` で、約定が最大 1 分先に記録される） | 仮想時計では足の `timestamp` の既定をいまの時刻にし、tick の後の時計を `timestamp + 1 分`（約定時刻と同じ値）にする。「いまの時刻から始まる 1 分足が閉じて、その終わりに約定し、時計もそこへ進む」形 | 時計が記録より後ろに残らない。後から出した注文の `ordered_at` が先の約定より前になる記録を作らない（決定 28 と噛み合う）。1 回で 60 秒以上進むことは変わらない |
| 過去の足を受けるか | いまの仮想時刻より前の `timestamp` は 400 `CANDLE_BEFORE_CLOCK` で断る | 約定時刻が既存の記録より前になり得るため。clock の巻き戻しの下限（決定 28）と揃える |
| clock の本文を省いたとき | 400 `CLOCK_TARGET_REQUIRED` で断る | 仮想時計では「現在時刻へ戻す」に意味が無く、黙って実時刻へ飛ぶと以後の記録が実時刻になる |
| 「N ミリ秒進める」指定の形 | `{ advanceMs }`（正の整数）。実時刻モードでも受ける。1 回で進める幅は 24 時間まで（実時刻モードではさらに実時刻 + 24 時間が上限）。`{ lastTickAt }` の絶対指定は、仮想時計では「既存の記録以後」かつ「いまの仮想時刻 + 24 時間以内」に限る | 決定 26・27・28 をそのまま形にした。両方を渡したら 400 `INVALID_CLOCK`（どちらを採るか決められない） |
| 仮想時計の成行 | 価格だけは実時刻の窓で取り（`SessionStore` の中で実時刻を読む）、記録する時刻は仮想にする | 仮想時刻を基準にすると、時計が実時刻より先にある間は足が無く、常に `70001` で断られる。成行は Plan A で互換を主張する範囲の外なので、この扱いを `docs/fidelity.md` に明記した |
| 仮想時計が効いているかを確かめる手段 | `GET /_control/state` に `clock: { mode: "virtual" }` を添える。**案から変えた点**: 実時刻モードでは付けない（案は `mode: "real"` も返す形だった） | 実時刻モード（既定）の応答の形を変えないため。無いことが実時刻の印になる |

あわせて決めたこと:

- **起動を断る判定は状態ファイルに触れる前**（ロックも取らない）。当たった理由をすべて標準エラーに出す
- 仮想時計で状態ファイルの `lastTickAt` が日付として解釈できないときも起動しない（記録する時刻が作れず、
  互換ルートが封筒でない 500 を返すため）
- 実時刻モードで作った状態ファイルを仮想時計で読むと、時計が記録より前にあることがある（上の 1 行目のとおり、
  実時刻モードの tick は約定を最大 1 分先に記録する）。起動は断らず、`POST /_control/clock` で記録以後へ
  置き直させる（記録より前へは置けないので、`advanceMs` が足りなければ `CLOCK_BEFORE_RECORDS` が置き先を返す）

---

## 18. 利用側の Plan A 向けの実験の口・その 2（2026-09-30）

17 節の 3 つ（PR A・B・C1・C2 で入れた）に続けて、利用側は次の 3 つをこのモックの上で扱う計画である。

1. REST の**応答不明**（状態は変わったのに、応答が届かない）
2. **レート制限**（HTTP 429 + 封筒 `10009`）
3. private stream の**切断**（状態を保ったまま接続が切れる）

本節は、これに合わせて Plan A の範囲を変える理由（18.1）と、実装の前に決めることを要判断事項 29 以降として
記録する（18.2）。**要判断事項はいずれも未決定**で、各項目の「案」は推奨にとどまる。PR の分け方は 18.3、
入れないものは 18.4 にある。**`src/` と `tests/` は 1 行も触っていない。** README と `docs/fidelity.md` は、
それぞれの実装 PR が挙動と同時に直す。

### 18.1 範囲を変える理由

利用側は、「応答不明」「通知の欠落」「順序入替」からの復帰を、本番では意図的に起こせないので、このモックの上で
確かめる計画である。**欠落と順序入替は PR B で入った**（`docs/fidelity.md` の「private stream の保留・再送」節）。
残る応答不明と、それに並ぶ 2 つは、これまでの計画では Plan A の外に置いたか、起こす口が無かった。

| 求めるもの | これまでの置き場所 |
|---|---|
| (1) 応答不明 | 17.4 が「REST 側の障害注入（応答が返らない・5xx・429）」を、利用側が Plan A で求める 3 つに入っていないとして Plan B 以降に置いた。README の「非目標（Plan A）」にも載っている |
| (2) レート制限 | `docs/fidelity.md` の「レート制限」節は「実装しない」で、「利用側への含意」は「負荷・429 復旧の実験には使えない」「モックは決して返さない」とする。README の「無いもの」も「どれだけ叩いても 429（`10009`）は返りません」。**実 API の HTTP 429 + 封筒 `10009` は 2026-09-17 に実測してある**（同節） |
| (3) stream の切断 | 接続を狙って切る口は `POST /_control/reset` だけで（close code `1012`）、reset は状態も作り直す（注文 id を 1 から配り直し、保留も解く。`docs/fidelity.md` の「private stream と状態の初期化」節）。PR B の hold は stream を**黙らせる**が、接続は保つ |

**この 3 つを Plan A に前倒しする。** 理由はそれぞれ次のとおり。

- **(1)** 応答不明は、欠落・順序入替と並んで、利用側が本番で意図的に起こせない 3 つの 1 つである。PR B で残りの
  2 つが入り、応答不明だけが踏めないまま残っている。17.4 で範囲外に置いたのは、17 節の時点で利用側が求めていた
  3 つに入っていなかったためで、要らないと判断したからではない
- **(2)** 利用側は、bitbank のレート制限（更新系 毎秒 6 回・参照系 毎秒 10 回。超えると HTTP 429 + 封筒 `10009`）の
  枠の中で、照合のポーリングを設計する。モックが 429 を返さない限り、429 を受けたときの振る舞いは本番で初めて通る
- **(3)** 利用側の fail-closed と再同期は、stream が**黙る**ときだけでなく**切れる**ときにも要る。今のモックで
  切るには reset するしかなく、そのとき状態も消えるので、「切れている間に進んだ状態変化を、繋ぎ直した後に照合で
  拾う」筋が組めない

利用側が扱うことと、それを踏むのに要るものの対応は次のとおり。

| 利用側が扱うこと | 踏むのに要るもの | 今のモック | PR |
|---|---|---|---|
| 応答不明からの復帰（発注・取消の応答が届かなくても、結果を照合で確かめる） | 状態は変わり、stream と REST の照合には注文が現れるのに、応答だけが届かないこと | 起こせない。近いのは書き出しに失敗した 1 本（応答は `70001` なのに、メモリには注文が残る。`docs/fidelity.md` の「private stream と永続化の失敗」節）だけで、これも応答自体は返るうえ、以後は劣化して状態を変える要求を断り続ける | D |
| レート制限（429 / `10009` を再試行の合図として扱う。`docs/fidelity.md` の「レート制限」節の「利用側への含意」） | 429 + `10009` が返ること | 返さない | D |
| fail-closed と再同期（stream が切れたとき） | 状態を保ったまま接続が切れること。切れたまま繋がらない時間 | reset でしか切れず、そのとき状態も消える | E |

**5xx は、17.4 で 429・応答不明と並べていたもの**である。同じ仕組み（要判断事項 29）で足せるので、故障の種類の
1 つとして 30 で扱う。

**`/_control/` を広げる基準にも照らした。** 13.2 の「プラン A で誰も踏まない条件のために制御面を広げない」には、
17.1 と同じく当たらない。3 つとも利用側が Plan A で踏む。

**これまでの記述は書き換えない。** 17.4 は当時の記録として残し、本節への参照だけを足した（17 節で 3.4 や 16.4 を
扱ったのと同じ）。README の「無いもの」「非目標（Plan A）」と `docs/fidelity.md`（「レート制限」節など）は、
挙動が変わる PR D・E で直す。

### 18.2 要判断事項（17.2 の続き。**いずれも未決定**）

番号は 17.2 の続きで 29 から振る。**15 と 16（足の取得）は未決定のまま残し、本節でも扱わない。**

**決定の欄は空けてある。** 各項目の「案」は推奨で、レビューで決まったら各項目の「決定」に決定と日付を
書き込む。

#### 29. 故障の指定のしかた（PR D）

利用側のテストは、「この発注の応答だけを失わせる」「429 を 2 回返してから通す」のような筋を、毎回同じ形で踏みたい。

| 選択肢 | 代償 |
|---|---|
| 回数で指定する（`/_control/` に「次の N 回の（メソッド, パス）に、この種類の故障を起こす」を登録し、当たるたびに残り回数を 1 減らす） | 指定したとおりにしか起きないので再現できる（保留・再送と同じ性質）。代償は、（メソッド, パス）で当てるので**本文やクエリでは絞れない**こと（「`order_id` が 5 の取消だけ」は指定できない）と、**並行に送った要求のどれに当たるかは、モックに届いた順で決まる**こと。狙った要求に当てたいテストは、その要求を直列に送る |
| 確率で指定する（「この口の要求を確率 p で故障させる」） | 手で組まない組み合わせを踏める。ただし**再現できない**。種を固定しても、要求の数が変わるたびに結果が変わる（17.2 の決定 19 で乱数での注入を入れなかったのと同じ理由） |
| 取り消すまで続ける（「この口は取り消すまですべて 429」） | 登録が 1 つで済む。代償は、「429 を 2 回返してから通す」のような、再試行が最後に通る筋を組むのに、テストが要求の合間で取り消しを挟む必要があること。回数で指定すれば 1 回の登録で済む |

**案（推奨）: 回数で指定する、決まった結果になる注入。** 乱数・確率は入れない（17.2 の決定 19 と同じ理由）。
あわせて次の形にする。

- **同じ（メソッド, パス）に複数登録したら、登録した順に使い切る**（先の登録の残りが 0 になってから、次の登録が
  当たる）。「429 を 2 回、その次に応答不明」のような列を、要求の前に 1 度の準備で組める
- **要求の中身に依らず、（メソッド, パス）が合えば当たる**（不正な本文の発注にも当たり、回数を減らす）
- 口の形（パス・本文・応答）は PR D で決め、`docs/fidelity.md` に書く。アクセス境界は他の `/_control/` と同じ
  （`docs/fidelity.md` の「control のアクセス境界」節）

**決定**: 未決定

#### 30. 故障の種類（PR D）

案の 3 つは次のとおり。

| 種類 | 状態 | 応答 | 利用側から見えるもの |
|---|---|---|---|
| 429 | 変えない | HTTP 429 + 封筒 `{"success":0,"data":{"code":10009}}` | 本番でレート制限を超えたときと同じ形（`docs/fidelity.md` の「レート制限」節の実測） |
| 5xx | 変えない | 5xx。**本文の形は推測になる** | 実 API の内部エラーの応答は未実測（`docs/fidelity.md` の「封筒に包まれない応答」節） |
| 応答不明 | **変える**（private stream の配信まで済ませる） | **返さずに接続を切る** | 発注が通ったか分からない。stream と REST の照合には注文が現れる |

- **429 と 5xx は、ハンドラへ入る前に返す。** 互換ルートのハンドラは中で `store.tick()` を呼ぶので
  （`GET /v1/user/subscribe` を除く）、入ってから返すと market モードでは約定が起き得る。前で返すので、足も
  取りに行かない
- **429 は、封筒に包んだうえで HTTP ステータスを 429 にする。** `err()`（`src/routes/envelope.ts`）は「HTTP
  ステータスは触らない（互換ルートは常に 200）」ので、ステータスは別に付ける。`10009` は `ErrorCode` にまだ無いので
  足す（errors.md に定義のある番号なので、同ファイルの「errors.md に定義の無い番号は置かない」には触れない）。
  `Retry-After` などのヘッダは実測の記録に無いので付けない
- **5xx のステータスの値と本文の形は PR D で決め、推測として `docs/fidelity.md` に書く。** 材料: 実 API で観測した
  内部エラーは `order_ids: [true]` への封筒 `10001`（"System error."）だけで（`docs/fidelity.md` の「パラメータの型強制」節）、
  5xx は測っていない。一方、「封筒に包まれない応答」節の「利用側への含意」は、`success` キーを持たない応答が
  返り得る前提でパーサを書くよう求めている
- **応答不明は、ハンドラを最後まで通してから切る。** 状態の差し替え → private stream の配信（保留中なら溜める。36）
  → 状態ファイルへの書き出し（`commit()` が待つ）まで済ませ、応答だけを送らずに接続を閉じる。書き出しまで済むので、
  モックを再起動しても注文は残る。切り方（TCP を閉じるか、リセットするか）で利用側の HTTP クライアントが出すエラーが
  変わるので、それも PR D で決めて書く。読み取りの口に当てれば、応答だけが失われる（market モードの tick は
  通常どおり走る）
- **応答を返さずに接続を保つ形（黙って待たせる）は入れない。** 利用側のタイムアウトを待つことになり、テストが
  時間に依存する。時間で遅らせる注入も同じ理由で入れない（18.4）

**4 つ目に「状態を変えたうえで 5xx を返す」を足すか。**

| 選択肢 | 代償 |
|---|---|
| 3 つ（上の表） | 仕組みが小さい。代償は、**5xx が常に「状態を変えていない」ので、利用側が「5xx なら未実行」と学習し得る**こと。実 API の 5xx が未実行を意味するかは分からない（一般に、前段の中継が時間切れで 5xx を返しても、裏で処理が通っていることはある）。これは PR D が `docs/fidelity.md` に足す節の「利用側への含意」に、「5xx を未実行の印として扱わないこと」と書いて手当てする |
| 4 つ（状態を変えたうえで 5xx を足す） | 上の学習を実験で潰せる（5xx を受けても、照合で注文を見つける筋を踏める）。代償は、種類が 1 つ増え、推測の本文を使う種類が 2 つになること。復帰の筋（照合で確かめる）は応答不明と同じなので、新しく踏める分岐は「5xx を受けた」の 1 つだけ |

**案（推奨）: 429・5xx・応答不明の 3 つ。** 時間で遅らせる注入は入れない（テストが時間に依存する）。

**決定**: 未決定

#### 31. 対象にするルート（PR D）

| 選択肢 | 代償 |
|---|---|
| 互換ルート（`/v1/user/...`）だけ | 利用側が本番で叩く口にだけ起きる。下の 2 つを対象にする理由が無いので、代償はほぼ無い |
| `/_control/` も含める | `/_control/` はテストの足場で、利用側が本番で叩かない口である。故障させても得るものが無く、故障を取り消す口まで故障し得る |
| `/_stream/private` も含める | WebSocket の upgrade で、429・5xx・応答不明の意味が REST と違う。「upgrade を断る」は 35 の「新しい接続を受け付けない」口と重なる |

**案（推奨）: 互換ルートだけ。** `/_control/` と `/_stream/private` は対象外にする。**対象外の（メソッド, パス）や、
モックに無い（メソッド, パス）を指定した故障の登録は 400 で断る。** 打ち間違いが黙って当たらないまま残ると、テストは
「故障が起きない」原因を探すことになる。（メソッド, パス）は Fastify に登録したルートの url で見る
（`src/server/degraded.ts` の `routeKey()` と同じ鍵で、`HEAD` は `GET` と同じに数える）。

**`GET /v1/user/subscribe` を含めるか。** subscribe は、private stream に繋ぐ前と、トークンの期限が切れた後に、
チャンネル名とトークンを取る要求である（`docs/fidelity.md` の「private stream」節）。

| 選択肢 | 代償 |
|---|---|
| 含める | 特例が要らない（`/v1/user/...` の 1 本として扱う）。利用側は「トークンを取り直せない」再接続を踏める。状態を読まず `store.tick()` も呼ばないので、応答不明は 429・5xx と同じく応答が失われるだけになる |
| 含めない | モック向けの接続層が subscribe を呼ばない利用側には、当てても意味が無い（WebSocket の接続ではチャンネル名もトークンも見ない。同節）。代償は、互換ルートの中に特例が 1 つ増えること |

**案（推奨）: 含める**（特例を作らない）。

**決定**: 未決定

#### 32. 本当に回数を数えるレート制限を入れるか（PR D）

29 の注入で 429 は返せる。それとは別に、実 API と同じく「毎秒の上限を超えたら 429」と数える仕組みを入れるか。

| 選択肢 | 代償 |
|---|---|
| 入れない（29 の注入で 429 を踏む） | テストが時間に依存しない。代償は、**利用側のポーリングが枠に収まっているかは、モックでは確かめられない**こと。429 を受けたときの振る舞いは確かめられるが、受けないように組めているかは、利用側が自分の要求を数えて確かめる |
| 実時刻で数える（既定では無効にし、env で有効にする、など） | 設計した間隔が枠に収まるかを試せる。代償は、**有効にしたテストが時間に依存する**こと（同じテストが、機械の速さや負荷で 429 を踏んだり踏まなかったりする）。窓の形（固定か滑るか）と数える単位も決めることになるが、`docs/fidelity.md` の「レート制限」節が記録しているのは上限の値と超えたときの応答だけで、どちらも推測になる |
| 仮想時計で数える | 時間に依存しない。ただし仮想時計は自分では進まない（17.2 の決定 26）ので、時計を進めない限りすべての要求が同じ瞬間に届いたことになり、更新系は 7 回目で必ず 429 になる。要求の合間に時計を進めるテストでしか使えず、手間は 29 の注入を置くのと変わらない |

**案（推奨）: 入れない。** テストが時間に依存するため。29 の注入で 429 を踏めれば足りる。README の
「非目標（Plan A）」の「レート制限」は残し、PR D で「429 は `/_control/` からの注入でだけ返る」と書き分ける。

**決定**: 未決定

#### 33. 登録した故障の寿命（PR D）

| 選択肢 | 代償 |
|---|---|
| メモリにだけ持ち、reset で捨てる | 保留・再送で溜めたものと同じ扱いになる（17.2 の決定 21: 前の実験の残りを次のシナリオへ持ち越さない）。`PaperState` に入らないので、スキーマは v3 のままで、`GET /_control/state` にも出ない。代償は、**モックの再起動で消える**こと。モックの再起動をまたぐ実験では、再起動の後に登録し直す |
| 状態ファイルに持つ | モックの再起動をまたいで残る。代償は、版を v4 に上げて移行を書くこと（17.2 の決定 25 で避けた手当て）と、登録が「状態ファイルに書く要求」になって劣化中に断られること（34 の案と両立しない） |
| メモリに持ち、reset でも捨てない | シナリオの冒頭で reset する使い方（`examples/scenario-plan-a.sh` など）で、前の実験で使い残した登録が、次のシナリオの最初の要求に当たる |

**案（推奨）: メモリにだけ持ち、reset で捨てる。** `/_control/` から残り（登録ごとの種類・（メソッド, パス）・残り回数）を
見られ、取り消せるようにする。残りが 0 になった登録を一覧に残すか（テストが「当たった」ことを確かめる手段にするか）は
PR D で決める。

**決定**: 未決定

#### 34. 書き出し失敗後の劣化中（PR D）

書き出しに失敗した後（`PERSIST_DEGRADED`。10.5）は、状態を変える要求を断る。故障の登録・参照・取消は、33 の案なら
`PaperState` を読みも書きもせず、状態ファイルにも書かない。

| 選択肢 | 代償 |
|---|---|
| 通す（17.2 の決定 23 で足した「状態ファイルに書かない control の口」、`NON_PERSISTING_CONTROL_ROUTES` に載せる） | 劣化中も、登録した故障を見て取り消せる。分類を増やさずに済む |
| 断る（503 `PERSIST_DEGRADED`） | 「劣化中は読むだけ」が保てる。代償は、劣化の前に登録した故障を、劣化中に取り消せないこと。読み取りの口（`orders_info` など）に登録した 429 が残っていれば、劣化中の照合がそのぶん断られる。読み取りを生かす、という劣化モードの約束に反する |

**案（推奨）: 通す。** 17.2 の決定 23 と同じ扱い。

**あわせて決めること: 劣化中に、故障の当たる要求が来たとき。** 劣化の判定（`src/server/http.ts` の
`registerDegradedGuard()` が足す `preHandler`）と故障のどちらを先に見るか。

- **案: 故障を先に当て、回数も減らす。** 数え方が劣化の有無に依らず、29 の「次の N 回」がそのまま読める。429・5xx は
  ハンドラの前で返すので（30）、劣化中の `70001` より先に出る。応答不明は、劣化の判定が返した応答（状態を変える
  要求なら `70001`）を送らずに切る。状態はもともと変わらないので、特例は要らない

**決定**: 未決定

#### 35. stream の切断（PR E）

今、private stream の接続をモックが切るのは次の 3 つの場合だけである。

| close code | いつ | 状態 |
|---|---|---|
| `1009` | クライアントから 1024 バイトを超えるフレームが来たとき（`ws` の `maxPayload`） | 変えない |
| `1011` | その接続へ送れなかったとき（`src/stream/hub.ts` の `sendTo()`） | 変えない |
| `1012` | `POST /_control/reset`（`docs/fidelity.md` の「private stream と状態の初期化」節） | 作り直す（注文 id を 1 から配り直し、保留も解く） |

`/_control/` から狙って切れるのは `1012` だけで、そのとき状態も消える。

**案（推奨）: `/_control/` に、状態と保留を残したまま全接続を閉じる口を足す**（口の形は PR E で決める）。保留は
解かず、溜めたものも捨てない。切っている間に進んだ変化は、保留していなければ誰にも届かない（接続が 0 本の間、hub は
メッセージを作らない。`docs/fidelity.md` の「private stream」節の「接続した後の変化だけが届く」）。後から届けたいなら、
切る前に hold し、繋ぎ直してから release する。17.2 の決定 18（保留中は購読者が 0 人でも溜める）がそのまま効くので、
組み合わせのための特例は要らない。

**close code を何にするか。** 公式の配信は PubNub で、WebSocket の close code は利用側の本番の経路には現れない
（接続層は差し替える前提。`docs/fidelity.md` の「private stream」節の「利用側への含意」）。**効くのはモック向けの
接続層だけ**なので、本物らしさより、他の切れ方と区別できることを優先して選ぶ。

| 選択肢 | 代償 |
|---|---|
| `1001`（Going Away） | 使っていない番号で、`1009` / `1011` / `1012` と区別できる。代償は、本来の意味が「サーバが止まる・ページを離れる」で、モックは動き続けること |
| `1011`（Internal Error） | 送れなかった接続を閉じるコードと同じになり、利用側のログで「モックが送れなかった」と「狙って切った」が分けられない |
| `1012`（Service Restart） | reset と同じになる。このモックで `1012` は「手元の注文の対応表を捨てて REST で取り直す」の合図にしてある（「private stream と状態の初期化」節）ので、状態を残す切断に使うと、利用側が要らないのに捨てる |
| close frame を送らずに TCP を切る（利用側には `1006` に見える） | ネットワークの断に一番近い。代償は、理由の文字列を渡せず、モックの不具合による切断と見分けられないこと |
| 呼ぶ側に選ばせる | どの切れ方も試せる。代償は、本文とその検査が増えること。モック向けの接続層で分岐を試しても、本番の PubNub の経路には効かない |

**案（推奨）: `1001` に固定する。** reason には切った口の名前を入れる（reset の `state reset by /_control/reset` と
同じ扱い）。

**「指定するまで新しい接続を受け付けない」口も足すか。** fail-closed の状態を長く保つための口である。

| 選択肢 | 代償 |
|---|---|
| 足す（受け付けない・受け付けるの 2 つ） | 切ったまま繋がらない状態を、利用側の再接続が速くても保てる。fail-closed の「一定時間状態を確認できない」と、繋がった後の再同期を、テストが決めた順で踏める。代償は口が増えること。断り方（upgrade の前に HTTP で断るか、受けてからすぐ閉じるか）も PR E で決める |
| 足さない | 口が 1 つで済む。代償は、切った直後に利用側が繋ぎ直すと、stream が無い時間がほぼ 0 になること。hold（黙らせる）で近いものは作れるが、接続は生きたままで、「繋がらない」は踏めない |

**案（推奨）: 足す。** 受け付けない状態は、保留と同じくメモリにだけ持ち（再起動で消える）、**reset で受け付ける状態に
戻す**（17.2 の決定 21 と同じく、前の実験の残りを次のシナリオへ持ち越さない）。切る口・受け付けない口・受け付ける口は、
どれも状態ファイルに書かないので、34 の案と同じく「状態ファイルに書かない control の口」に載せ、劣化中も通す。

**決定**: 未決定

#### 36. 応答不明と、PR B の保留の関係（PR D）

30 の応答不明は「private stream の配信まで済ませてから」切る。保留中（`POST /_control/stream/hold` の後）なら、
配信の代わりに溜まる。

| 選択肢 | 代償 |
|---|---|
| 特例を作らない（保留中なら、その変化のメッセージも溜まる） | hold / release の約束（指定したとおりにしか送らない）が崩れない。「応答も stream も届かない」を組め、利用側が REST の照合でしか注文を見つけられない筋を踏める。応答不明からの復帰を一番厳しい形で確かめられる |
| 応答不明の変化だけは保留を無視して送る | 「応答不明の注文は stream には必ず現れる」を保証できる。代償は、release で並べた列の外で先に届き、保留中の順序の指定に割り込むこと |
| 応答不明の変化は stream にも流さない | 「応答も stream も無い」を 1 つの指定で作れる。代償は、状態と stream を食い違わせる特例になること（16.1 の決定 13 で避けた形）。同じものは、保留して release でその番号を書かなければ作れる |

**案（推奨）: 特例を作らない。** 保留中なら、その変化のメッセージも溜まる。

**決定**: 未決定

### 18.3 PR の一覧と依存関係

| PR | 中身 | 前提となる PR | 決める要判断事項 |
|---|---|---|---|
| 0' | 計画: 本節を足す（範囲の変更と、要判断事項 29 以降） | なし | —（29〜36 を記録する） |
| D | REST の障害注入（429・5xx・応答不明） | 0' | 29〜34・36 |
| E | stream の切断（と、新しい接続を受け付けない口） | 0' | 35 |

- **D と E は互いに依存しない。** D は互換ルートの要求の前後（Fastify のフック）と `/_control/` を、E は
  `src/stream/hub.ts` と `/_control/` を触る。どちらも `src/server/degraded.ts` の `NON_PERSISTING_CONTROL_ROUTES` に
  口を足すので、後から入るほうがそこで合わせる
- **36 は D で決める**（応答不明の側の振る舞いなので）。D も E も、保留・再送（PR B）の仕組みには手を入れない
- **README と `docs/fidelity.md` は各実装 PR が直す。** D は「レート制限」節（「利用側への含意」の「モックは決して
  返さない」）・「封筒に包まれない応答」節（5xx の本文）・「`/_control/`」節と、README の「無いもの」「非目標（Plan A）」。
  E は「private stream」節から始まる一連の節と README。どちらも `docs/fidelity.md` の「v0.1.0 からの改訂」に 1 行ずつ
  足す。0' は挙動を変えない

### 18.4 入れないもの

- **時間で遅らせる注入、乱数での注入**（要判断事項 29・30 の案。17.2 の決定 19 と同じ理由）
- **本当に回数を数えるレート制限**（要判断事項 32 の案なら）
- **板と成行の拡張、`btc_jpy` 以外のペアの桁、ペア別の手数料**。利用側のプランが決まってから
