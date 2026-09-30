# bitbank-lab-mock

[![CI](https://github.com/tjackiet/bitbank-mock-api/actions/workflows/ci.yml/badge.svg)](https://github.com/tjackiet/bitbank-mock-api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

挙動確認・検証目的で作成している、bitbank Private REST API モック。注文の状態を持つ挙動確認用であり、**bitbank 公式のテスト環境ではない**。

## はじめにお読みください

- 本ツールは**開発段階（ベータ版）**です。利用は**自己責任**でお願いします。
- ご利用の前に必ず [⚠️ 免責事項](#免責事項) をお読みください。
- 本リポジトリは **bitbank バグバウンティプログラムの対象範囲外** です。
- 公開ドキュメントに準拠した**近似**であり、動作保証はしません。本物との差分は [`docs/fidelity.md`](docs/fidelity.md) を正とします。

## これは何

bitbank Private REST API と同じパスで、**発注・約定・取消・注文照会・残高照会**ができるモックサーバです。どれも 1 つの状態（注文・約定・仮想残高）を共有しているので、発注すると残高が拘束され、約定すると約定履歴と残高に反映され、取り消すと拘束が外れます。固定の応答を返すスタブではありません。状態の変化は **private stream**（WebSocket）でも push で受け取れます（下の「[private stream](#private-stream)」節）。状態はファイルに書き出し、再起動後も引き継ぎます（書き出しに失敗したときの扱いは「[環境変数](#環境変数)」節）。

発注から約定、残高の変化までの一連は [`examples/scenario-plan-a.sh`](examples/scenario-plan-a.sh) で確かめられます。何がどこまでできるかを根拠つきで確かめるなら [`docs/plan-a-readiness.md`](docs/plan-a-readiness.md) の「2. このモックで何ができるか」を読んでください。

### 約定エンジン

約定の判定は `src/engine/` の約定エンジンが行います。**板は持たず、1 分足で判定します。** 発注以降に始まった足のうち、買いは安値が指値以下、売りは高値が指値以上になったものがあれば、残量全部を指値の価格で約定させます。足の入手元は `BITBANK_MOCK_FILL_MODE` で選びます。

- **`market`**: bitbank 公式 public API の 1 分足を取得して約定させます。裏で常時監視するのではなく、互換ルートへの要求を受けるたびに、前回からの足をまとめて確かめます
- **`manual`**: 指値は自動では約定しません。`POST /_control/tick` で足を 1 本ずつ与えるか、`POST /_control/orders/:order_id/fill` で注文を指定して約定させます（数量を指定すれば部分約定）。市場の値動きに左右されず、同じシナリオを再現するためのモードです

既定は、`/_control/` を有効にしたとき（`BITBANK_MOCK_CONTROL=1`）が `manual`、無効なら `market` です。成行注文だけはモードによらず、公式 public API から直近の終値を取ってその場で全量約定させます（`manual` でも外へ取りに行きます）。終値が取れなかったとき（取得の失敗や、直近 5 分に足が無いとき）は `70001` で断り、注文は作りません。

### 無いもの

- **PubNub**: private stream は PubNub ではなく素の WebSocket で配信します。PubNub SDK のままでは繋がりません（下の「[private stream](#private-stream)」節）
- **private stream の自然な入れ替わり**: モックは自分からは順序を入れ替えず、重複も欠落も起こしません（公式は順序を保証しません）。耐性を試すときは `/_control/stream/*` の保留・再送で、入れ替わり・重複・欠落を狙って起こします（下の「[`/_control/`](#_control)」節）
- **認証ヘッダの検証**: どんなヘッダでも、無くても通ります。private stream の接続も同じです。本物の API キーを向けないでください
- **レート制限**: どれだけ叩いても 429（`10009`）は返りません
- **注文訂正**: 発注後に価格や数量を変える口はありません

意図して実装していないものの一覧は「[非目標（Plan A）](#非目標plan-a)」、本物との差分（手数料が単一の料率であることなど）は [`docs/fidelity.md`](docs/fidelity.md) にあります。

### Plan A とは

**Plan A** は [`docs/plan-lab-mock.md`](docs/plan-lab-mock.md) が定める**計画の段階名**で、リリースの版数ではありません。計画文書と `docs/fidelity.md` に出てくる `R` と `Phase` の番号は、それぞれ計画側の要件番号と着手の順です。たとえば private stream は要件 `R4` にあたり、`Phase 5` として実装しました。README ではどちらの番号も使いません。

### どのリビジョンを渡すか

**`package.json` の `version` は現在の挙動を表しません**（理由と扱いは [`docs/plan-a-readiness.md`](docs/plan-a-readiness.md) の「7. 版と改訂の所在」）。`v0.1.0` タグは実在しますが、**そこから挙動を変える改訂が入り続けています**。

- **渡すのは commit SHA です。** タグでもブランチ名でもありません（`v0.1.0` は現在の挙動と違い、`main` は動くので同じ名前が後から別の挙動を指します）
- **SHA は渡すチェックアウトそのものから取ります**——`git rev-parse HEAD`。最新の `main` を渡すなら**先に `git fetch origin main` してから** `git rev-parse origin/main`（remote-tracking ref は fetch するまで古いままなので、そうしないと渡した SHA と手元の内容がずれます）
- 受け取った側が同じ SHA を `git checkout` すれば、挙動と [`docs/fidelity.md`](docs/fidelity.md) の記述がそろいます（対応表が書き表すのは、いま読んでいるリビジョンの挙動です）
- **`v0.1.0` から何が変わったか**は [`docs/fidelity.md` の「v0.1.0 からの改訂」](docs/fidelity.md#v010-からの改訂) に索引があります

## 実装しているエンドポイント

bitbank Private REST API に対応する互換ルートは次のとおりです。本文を取る経路は `content-type: application/json` で送ってください。

| メソッド | パス | パラメータ |
| --- | --- | --- |
| `POST` | `/v1/user/spot/order` | `pair` / `amount` / `price`（任意）/ `side`（`buy` \| `sell`）/ `type`（`limit` \| `market`） |
| `GET` | `/v1/user/spot/order` | `pair` / `order_id` |
| `POST` | `/v1/user/spot/orders_info` | `pair` / `order_ids`（配列） |
| `GET` | `/v1/user/spot/active_orders` | `pair`（任意。省略で全ペア）/ `count` / `from_id` / `end_id` / `since` / `end` |
| `GET` | `/v1/user/spot/trade_history` | `pair`（任意。省略で全ペア）/ `count` / `order_id` / `since` / `end` / `order`（`asc` \| `desc`） |
| `POST` | `/v1/user/spot/cancel_order` | `pair` / `order_id` |
| `POST` | `/v1/user/spot/cancel_orders` | `pair` / `order_ids`（1 件以上 30 件以下） |
| `GET` | `/v1/user/assets` | なし |
| `GET` | `/v1/user/subscribe` | なし（ダミーの `pubnub_channel` / `pubnub_token` を返す。「[private stream](#private-stream)」節） |

**この表はパラメータの名前までで、契約そのものではありません。** 値をどう解釈するか・何を返すか・どの入力をどの error code で断るかの正は [`docs/fidelity.md`](docs/fidelity.md) です。本物との差分の記録であると同時に、**このモックの契約書でもあります**。読む順は同ファイルの「[v0.1.0 からの改訂](docs/fidelity.md#v010-からの改訂)」で今の版を把握してから、対応表の該当する節へ。

**`order_ids` の 30 件上限は `cancel_orders` にだけあります**（公式 `rest-api.md` の `cancel_orders` のパラメータ表が "Up to 30 ids can be specified" と書き、`orders_info` の表には上限の記載がありません）。超えると `40015` で断り、**1 件も取り消しません**。`orders_info` には上限を設けていません（非対称は公式どおりです。[`docs/fidelity.md`](docs/fidelity.md) の「一括取消の件数上限」の節）。

**未約定の注文は口座全体で 30 本までです**（公式 `errors.md` の `60011`「Too many Simultaneous orders, current limit is 30.」）。既に 30 本あるときの新規発注は `60011` で断り、**状態を一切変えません**。**上の `cancel_orders` の「1 要求あたり 30 ID」とは別の制限です**——同じ 30 でも数える対象が違い（載せる ID の件数と、同時に持てる注文の本数）、単位を口座全体にしたのは推測です（[`docs/fidelity.md`](docs/fidelity.md) の「同時未約定注文の上限」の節）。

**`trade_history` は `from_id` / `end_id` を持ちません**（公式 `rest-api.md` のパラメータ表に無いため。送られても黙って無視します。実 API は絞り込みに使うので、同じ要求で結果が変わります。経緯は [`docs/fidelity.md`](docs/fidelity.md) の「絞り込みパラメータの不正値」の節）。

実際に叩く例は [`examples/scenario-plan-a.sh`](examples/scenario-plan-a.sh) にあります。`/_control/` の経路は下の「[`/_control/`](#_control)」節、private stream は「[private stream](#private-stream)」節です。

## private stream

注文・約定・残高の変化を push で受け取る口です。**PubNub ではなく素の WebSocket** で、接続先は `ws://<host>:<port>/_stream/private`（互換ルートと同じアドレスとポート）です。

```bash
# Node.js 22 以降（グローバルの WebSocket を使う）。Node.js 20 なら `ws` パッケージで同じことができます
node -e 'const ws = new WebSocket("ws://127.0.0.1:14000/_stream/private"); ws.onmessage = (e) => console.log(e.data)'
```

1 フレームに公式と同じ形の JSON が 1 つ届きます。

```json
{"message":{"method":"spot_order_new","params":[{"order_id":1,"pair":"btc_jpy","status":"UNFILLED","is_just_triggered":false,"...":"..."}]}}
```

| `method` | いつ届くか | 中身 |
| --- | --- | --- |
| `spot_order_new` | 注文が新しく現れたとき | 注文オブジェクト（REST の注文に `executed_at` と `is_just_triggered` を足したもの） |
| `spot_order` | 既にある注文の状態が変わったとき（約定・取消） | 同上 |
| `spot_trade` | 約定したとき | `trade_history` と同じ約定オブジェクト |
| `asset_update` | 残高か拘束額が変わったとき | 変わった資産 1 つ（キーは既定で camelCase。`BITBANK_MOCK_STREAM_ASSET_KEYS=snake` で snake_case） |

`spot_order_invalidation` は送りません（発生条件の「マッチングエンジン内の資産不足」がこのモックでは起こり得ないため）。

知っておいてほしい点:

- **接続した時点の状態は送りません。** 接続の後の変化だけが届くので、接続してから REST で取り直して突き合わせてください
- **`GET /v1/user/subscribe` の `pubnub_channel` / `pubnub_token` はダミーです。** 接続では見ません。期限切れも起きません
- **いつ届くかはモック固有です。** `manual` モードでは互換ルートの発注・取消と `/_control/` の操作でだけ届きます。`market` モードでは誰かが互換ルートを叩いたとき（読み取りでも）に約定とイベントが起きます（control を有効にしていれば `/_control/` の fill / tick でも起きます）。**ただし `GET /v1/user/subscribe` だけは状態を読まないので、叩いても約定は進みません**。裏で市場を見張ってはいないので、**何も叩かなければ何も届きません**
- **HTTP の応答より先に届くことがあります。** 状態がメモリに反映された直後に送るためで、書き出しに失敗して `70001` を返した発注のイベントも流れます
- **`POST /_control/reset` は接続を close code `1012` で閉じます。** reset で注文 id が 1 から配り直されるためです。繋ぎ直して、手元の注文の対応表を REST で取り直してください。保留中なら溜めたものも捨て、保留を解きます
- **モックは順序を入れ替えません。** 入れ替わり・重複・欠落は `/_control/stream/*` の保留・再送で起こします（下の「[`/_control/`](#_control)」節）。**保留の後に繋いだ接続にも、release で繋ぐ前の変化が届きます**（「接続した後の変化だけが届く」の例外）
- クライアントから送ったものは読みません（1024 バイトを超えるフレームは close code `1009` で閉じます）。upgrade でない `GET /_stream/private` には `426` を返します

どこまで本物と同じか・どこを推測で決めたかは [`docs/fidelity.md`](docs/fidelity.md) の「[private stream](docs/fidelity.md#private-stream)」節から始まる一連の節にあります。

## `mock-bitbankcc` との棲み分け

| | 本リポジトリ | [`bitbankinc/mock-bitbankcc`](https://github.com/bitbankinc/mock-bitbankcc) |
| --- | --- | --- |
| 用途 | 注文状態を持つ挙動確認・検証 | SDK テスト用の静的スタブ |
| 実装 | 仮想残高・約定・永続化 | WireMock の固定レスポンス |
| 公式テスト環境か | いいえ | いいえ |

## 起動

Node.js 20 以上。

```bash
git clone https://github.com/tjackiet/bitbank-mock-api.git
cd bitbank-mock-api
npm ci
BITBANK_MOCK_CONTROL=1 npm run dev
```

既定は `http://127.0.0.1:14000`（control 有効時。無効時は `0.0.0.0:14000`）。ポートは `BITBANK_MOCK_PORT`、または `serve` に続けて `--port`（`npm run dev -- serve --port 14001`）。**`--port` だけを渡すと `unknown command: --port` で起動しません**——引数の 1 つ目はサブコマンドとして読むためです。

再現シナリオ（発注 → 拘束 → control fill → 残高減）:

```bash
BITBANK_MOCK_CONTROL=1 npm run dev
# 別端末
./examples/scenario-plan-a.sh
```

`curl` だけで動きます（JSON の取り出しは `sed` / `grep`）。**何度流しても同じ値が出るよう、先頭で `POST /_control/reset` を叩いて状態を捨てます。** 取っておきたいシナリオがあるときは `BITBANK_MOCK_STATE_PATH` を分けてください。

## 環境変数

| 変数 | 既定 | 説明 |
| --- | --- | --- |
| `BITBANK_MOCK_CONTROL` | 未設定（control 無効） | `1` のとき `/_control/` を登録する |
| `BITBANK_MOCK_FILL_MODE` | control 有効時 `manual`、無効時 `market` | `manual` では REST の `tick()` が市場足を取りに行かない |
| `BITBANK_MOCK_HOST` | control 有効時 `127.0.0.1`、無効時 `0.0.0.0` | listen アドレス |
| `BITBANK_MOCK_PORT` | `14000` | listen ポート |
| `BITBANK_MOCK_CONTROL_TOKEN` | 未設定 | 非ループバックからの `/_control/` に必要な `X-Control-Token` |
| `BITBANK_MOCK_STREAM_ASSET_KEYS` | `camel` | private stream の `asset_update` のキーの綴り。`snake` のときだけ snake_case（`free_amount`）、それ以外は camelCase（`freeAmount`）。公式の表と例が食い違っているので、両方でパーサを試せるようにしてある |
| `BITBANK_MOCK_PERSIST_FAILURE` | `degrade` | 状態ファイルへの書き出しに失敗した後の挙動。`degrade` は状態を変える要求を断り読み取りは生かす。`ignore` は v0.1.0 の挙動（何も断らない） |
| `BITBANK_MOCK_STATE_PATH` | `~/.bitbank-mock/sessions/default/state.json` | 状態ファイルのパス |
| `BITBANK_MOCK_HOME` | `~/.bitbank-mock` | `STATE_PATH` 未指定時のルート |
| `BITBANK_PUBLIC_BASE_URL` | `https://public.bitbank.cc` | 足を取りに行く公開 API のベース URL（`BITBANK_MOCK_FILL_MODE=market` のときだけ使う） |
| `BITBANK_MOCK_URL` | `http://127.0.0.1:14000` | **サーバは読みません。** `examples/scenario-plan-a.sh` が叩き先として読みます。既定以外のポートで起動したときに使ってください |

状態ファイルは起動時に検査します。JSON が壊れている・スキーマに合わない場合に加えて、[`docs/fidelity.md`](docs/fidelity.md) の「状態の不変量（PaperState v3）」のうち単一の状態から判定できるもの（不変量 1〜3・5・6）を破っている場合も**起動しません**（自動修復も初期化もしません。ファイルはそのまま残します）。エラーには破れた不変量の番号と、その対象を特定する識別子が出ます（不変量 1〜3・5 は注文 ID、注文の無い trade は trade ID、不変量 6 は資産キー）。

```
Error: paper state violates invariants: 6 violation(s): 1: order 1 executedAmount=0.005 startAmount=0.001; 2: order 1 status=UNFILLED executedAmount=0.005; 5: order 1 trades=0 executedAmount=0.005; 5: order 1 tradeNotional=0 executedNotional=25000; 6: balance[jpy]=-500000 is negative; 6: locked[jpy]=-20024 exceeds balance=-500000
```

v1 / v2 の状態ファイルを v3 へ移行した結果が不変量を破っている場合だけは、起動を止めずに warn を出します（`migrated paper state violates invariants: ...`）。

**書き出しに一度でも失敗すると、以後は状態を変える要求を断ります**（v0.1.0 からの変更）。発注・取消・`/_control/` の fill / tick / clock / reset は断り、照会（`GET order` / `orders_info` / `active_orders` / `trade_history` / `assets` / `GET /_control/state`）は今までどおり通します。状態ファイルに書かない `/_control/stream/*`（private stream の保留・再送）も通します。失敗したシナリオを読み出せるようにするためです。断り方は互換ルートが封筒の `70001`、`/_control/` が 503 `PERSIST_DEGRADED` です。

**復帰は再起動です。** ディスクを直す → `GET /_control/state` でシナリオを読み出す → 再起動、の順で進めてください。劣化中は市場モードの自動約定も止まります（読むたびにメモリだけ進んで状態ファイルとの差が開くのを避けるため）。

書き込みが効いているかは `GET /_control/state` の `persist` で確かめられます（`consecutiveFailures > 0` なら今まさに失敗しています。`lastError` は成功しても消えないので、一度でも失敗したかが残ります）。v0.1.0 の挙動に戻すには `BITBANK_MOCK_PERSIST_FAILURE=ignore` を設定してください。

**同じ状態ファイルを 2 プロセスから使うことはできません。** 起動時に `<状態ファイル>.lock` を取り、既に生きているプロセスが持っていれば起動しません（黙って壊れるのではなく、弾きます）。並列にシナリオを流すときは `BITBANK_MOCK_STATE_PATH` をシナリオごとに分けてください。

`SIGKILL` などでロックが残った場合は、次の起動が保持プロセスの生死を見て奪うので手で消す必要はありません。**ロックは二重起動を弾くためのもので、競合を防ぎ切るものではありません**（2 プロセスが同じ残存ロックを同時に奪いに行く窓が残っています）。詳しくは [`docs/fidelity.md`](docs/fidelity.md) の「同一状態ファイルの多重起動」の節を見てください。

## `/_control/`

bitbank API には存在しません。本番クライアントから叩かないでください。応答は bitbank 封筒ではなく素の JSON です。

| メソッド | パス | 動作 |
| --- | --- | --- |
| `POST` | `/_control/orders/:order_id/fill` | 指定注文を約定。`amount` 省略は残量全部、`price` 省略は指値 |
| `POST` | `/_control/tick` | `{ pair, price }` または `{ pair, candle }` で人工の足を 1 本適用 |
| `POST` | `/_control/clock` | 時計（`lastTickAt`）を動かす。本文省略で現在時刻、`{ lastTickAt }` に ISO 文字列かエポックミリ秒。注文・約定・残高は残る（`updatedAt` は書き込み時刻として動きます） |
| `POST` | `/_control/reset` | 状態を初期化（private stream の接続は close code `1012` で閉じ、保留中なら溜めたものを捨てて保留を解く） |
| `GET` | `/_control/state` | `PaperState` に、状態ファイルへの書き出しの状況（`persist`）と足の取得の状況（`candles`）を添えて返す |
| `POST` | `/_control/stream/hold` | private stream の保留を始める。以後の変化のメッセージは送らずに溜める（接続が 0 本でも溜める） |
| `GET` | `/_control/stream/held` | 保留の状況と、溜めたメッセージを溜めた順に番号（`seq`、1 から）付きで返す |
| `POST` | `/_control/stream/release` | `{ order: [番号, ...] }` の順に、その時点で接続している全員へ送って保留を解く。`order` 省略は溜めた順にすべて。送るものがあるのに接続が 0 本なら 409（溜めたものは残る） |

**private stream の順序の入れ替わり・重複・欠落は、保留・再送で起こします。** hold してから変化を起こし、held で番号を確かめて、release の `order` に並べます。同じ番号を 2 度書けば重複、書かなかった番号は欠落です。たとえば指値を半分ずつ 2 回約定させる間を保留すれば、`FULLY_FILLED` の `spot_order` の後に `PARTIALLY_FILLED` の `spot_order` を届けられます。

```bash
curl -s -X POST localhost:14000/_control/stream/hold
# ……部分約定と全量約定を起こす……
curl -s localhost:14000/_control/stream/held          # messages[].seq と messages[].frame を見る
# 部分約定の spot_order が 1 番、全量約定の spot_order が 5 番だったなら、5 → 1 の順に送る（他は欠落）
curl -s -X POST localhost:14000/_control/stream/release -H 'content-type: application/json' -d '{"order":[5,1]}'
```

接続が 1 本も無いときの release は、溜めたものが誰にも届かずに消えないよう 409 `NO_STREAM_CLIENTS` で断ります（保留も溜めたものも残ります）。溜めたものを捨てたいときは `{"order":[]}` で release してください。

溜めるのは 10,000 通までです。超えた後の変化は溜めずに `overflowed` と `dropped`（落とした通数）を残し、以後の release は 409 で断ります（発注などの状態を変える要求は断りません）。抜け出すのは `POST /_control/reset` です。溜めたものはメモリにだけあり、再起動で消えます。細則は [`docs/fidelity.md`](docs/fidelity.md) の「private stream の保留・再送」の節にあります。

**市場モード（`BITBANK_MOCK_FILL_MODE=market`）で足が取れているかは `GET /_control/state` の `candles` で確かめます。** 取得に失敗しても互換ルートは成功応答を返し続け、失敗した窓は取り直さないので、**約定が無いことだけからは「価格が注文に届いていない」と「足の取得に失敗している」を区別できません**。`lastError`（直近の失敗。成功しても消えません）、`consecutiveFailures`（連続失敗数。今まさに失敗し続けているか）、`lastSuccessAt`（いつまで足が取れていたか。`lastTickAt` と並べて読みます）、`fillMode`（`manual` なら `tick()` はそもそも取りに行きません）を見てください。詳細は [`docs/fidelity.md`](docs/fidelity.md) の「足の取得の健全性」の節にあります。

`POST /_control/tick` が進める `lastTickAt`（control の時計）は、足の `timestamp` でも tick ごとの 60 秒の前進でも、実時刻より先へは 24 時間までしか動きません。超える要求は 400（`CANDLE_TOO_FAR_AHEAD` / `CLOCK_TOO_FAR_AHEAD`）で断り、状態は変えません。戻すのは `POST /_control/clock` です（`reset` と違って注文・約定・残高は残ります）。詳細は [`docs/fidelity.md`](docs/fidelity.md) の「control の時計」の節にあります。

無効時は 404。非ループバックはトークンが一致しない限り 403 です。状態ファイルへの書き出しに失敗した後は、状態を変える口（`fill` / `tick` / `clock` / `reset`）が 503 `PERSIST_DEGRADED` になります（`GET /_control/state` と、状態ファイルに書かない `stream/hold` / `stream/held` / `stream/release` は通ります）。**ループバックからはトークン無しで通る**ので、同一ホスト上の他プロセスからの誤操作は防げません。接続元の判定には TCP の対向アドレスだけを使い、`X-Forwarded-For` は見ません（Fastify の `trustProxy` の設定に境界は左右されません。ただし判定を `request.ip` に変えると、`trustProxy` を有効にした瞬間にヘッダの詐称で迂回できるようになります）。`X-Control-Token` はヘッダ行がちょうど 1 本のときだけ受け付けます。

## 非目標（Plan A）

- 公式 testnet / 動作保証 / 全 error code の網羅
- 認証ヘッダの検証、レート制限、注文訂正
- ダッシュボード、public REST の網羅、PubNub での配信
- 障害注入のうち、REST 側（応答が返らない・5xx・429）と、private stream の時間で遅らせる注入・乱数での注入・接続ごとの注入（private stream の重複・順序入替・欠落は `/_control/stream/*` の保留・再送で起こせます）

計画の詳細は [`docs/plan-lab-mock.md`](docs/plan-lab-mock.md) です。

## 開発

```bash
npm test          # vitest run（カバレッジは測りません）
npm run coverage  # vitest run --coverage（閾値割れで終了コード 1）
npm run typecheck
npm run lint      # biome ci（整形・lint・import の並び。警告もエラー扱い）
npm run format    # biome check --write（整形と安全な自動修正を当てる）
```

整形と lint は [Biome](https://biomejs.dev/) に寄せています（`biome.json`）。手で揃えず `npm run format` を当ててください。

CI（`.github/workflows/ci.yml`）は Node 24 で `npm ci` → `npm run lint` → `npm run typecheck` → `npm run coverage` を走らせます。カバレッジの下限は `vitest.config.ts` が持ち、**現状値の少し下に置いたラチェット**です（未到達のコードが新しく入ったときに落ちる下限で、目標値ではありません）。`src/index.ts` は計測から外しています——`tests/index.test.ts` が子プロセスとして起こして検証するので、v8 のカバレッジが追えず 0% と出るためです。

## 免責事項

構成は [bitbank-lab-cli の免責事項](https://github.com/bitbankinc/bitbank-lab-cli#免責事項) に合わせ、本モック向けに文言を置いています。

### 開発段階について

本ツールは開発段階（ベータ版）です。バグ、不具合、誤動作、または公開ドキュメントと異なる応答を含む可能性があります。bitbank 公式のテスト環境ではなく、互換性や継続提供を保証するものではありません。

### AI エージェントによる処理結果について

本モックサーバが提供するデータを AI エージェント等が処理・生成した結果について、正確性、完全性、有用性、最新性を保証するものではありません。AI エージェント等による処理の結果、注文種別、価格、数量その他の取引条件が利用者の意図と異なる形で処理または実行される可能性があります。

### 金融商品取引法上の位置づけ

本ツールは情報提供および挙動確認・検証のみを目的として提供されるものであり、投資助言・代理業、投資勧誘、その他金融商品取引法上の行為を目的とするものではありません。

### 外部サービスへの依拠

本ツールは外部 API、LLM、第三者サービス等に依拠して提供するものであり、これらの仕様変更、停止、不具合等が生じた場合には、本ツールが正常に動作しない可能性があります。`BITBANK_MOCK_FILL_MODE=market` のときは公開ローソク足を取得します。

### 安全対策の補助性

本ツールに実装されているバリデーション、`/_control/` のアクセス制限その他の安全対策は、誤操作を減らすための補助機能であり、その完全な防止を保証するものではありません。Plan A では認証ヘッダを検証しません。本物の API キーを本モックに向けないでください。

### 利用者の責任

利用者は、本ツールにより提供・生成された情報および注文内容等を自身で十分に確認の上、自己の判断と責任において本ツールを利用し、投資判断、注文実行および取引を行うものとします。本モック上の約定・残高は仮想であり、bitbank 本番口座には反映されません。

### 損害の免責

当社は、本ツールの利用もしくは利用不能、または本ツールにより提供・生成された情報、AI エージェント等による処理結果もしくは取引操作に基づく投資判断・注文・取引等に関連して生じたいかなる損害についても、当社の故意または重過失による場合を除き、一切責任を負いません。

### APIキー・認証情報の管理

APIキーおよび取引に必要なパスワード等は利用者自身の責任において適切に管理してください。チャット欄や公開リポジトリその他第三者が閲覧可能な環境等へ APIキーや取引パスワード等の認証情報等を入力・掲載しないよう十分ご注意ください。

利用者による認証情報等の管理不備、誤入力、漏えい、第三者利用等により生じたいかなる損害についても、当社の故意または重過失による場合を除き、当社は一切責任を負いません。

## License

MIT
