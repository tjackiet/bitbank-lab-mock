# CLAUDE.md

このリポジトリで作業するセッション向けのプロジェクト規約。各セッションが規約を再発見しなくて済むよう、ここに集約する。

## プロジェクトの位置づけ

- 挙動確認・検証目的で作成している bitbank Private REST API モック（パッケージ名 `bitbank-lab-mock`、リポジトリ名 `bitbank-mock-api`）。
- **bitbank 公式のテスト環境ではない。** 公開ドキュメントに準拠した近似で、動作保証はしない。bitbank バグバウンティプログラムの対象範囲外。
- 本物との差分は [`docs/fidelity.md`](docs/fidelity.md) が正。**挙動の根拠は実装より先にこれを読む。**
- 計画と設計判断は [`docs/plan-lab-mock.md`](docs/plan-lab-mock.md)。[`docs/design.md`](docs/design.md) は Plan A 以前の設計メモ（**履歴**。実装と食い違う箇所の一覧が冒頭にある）で、根拠には使わない。

## コマンド

| コマンド | 実行内容 |
| --- | --- |
| `npm test` | `vitest run`（**カバレッジは測らない**。速い内側の輪として使う）。`examples/scenario-plan-a.sh` を実プロセスのサーバへ流す回があるので、**`bash` と `curl` が要る** |
| `npm run coverage` | `vitest run --coverage`。閾値は `vitest.config.ts` が持ち、**割れると終了コード 1**。`src/index.ts` は計測から外す（`tests/index.test.ts` が子プロセスで検証するので v8 が追えず 0% と出るため） |
| `npm run typecheck` | `tsc --noEmit`（`src/**/*` と `tests/**/*` と `vitest.config.ts`） |
| `npm run lint` | `biome ci . --error-on-warnings`。整形・lint・import の並びを見る。**警告もエラー扱い**なので、Biome が何か言ったら赤 |
| `npm run format` | `biome check . --write`。整形と安全な自動修正を当てる。**`lint` が赤いときはまずこれ** |
| `npm run dev` | `tsx src/index.ts`。listen は control 有効時 `127.0.0.1:14000`、**無効時 `0.0.0.0:14000`**。ポートは `BITBANK_MOCK_PORT` か `serve --port`（**`--port` 単独は `unknown command` で落ちる**） |

`/_control/` を使うなら `BITBANK_MOCK_CONTROL=1`。環境変数の一覧は [`README.md`](README.md) の「環境変数」節。

**整形と lint は Biome**（`biome.json`）。**手で揃えない**——`npm run format` を当てる。字下げはスペース 2、行幅 100、クォートは二重、import は Biome が並べ替える。

ルールは `recommended` のまま 1 つだけ狭めている: **`style/noNonNullAssertion` は `src/**` だけで有効**（`biome.json` の `overrides` が `tests/**` で切る）。src の `!` は実行時の `undefined` を隠すが、テストの `orders[0]!` は外すと `toBeDefined()` と絞り込みの 2 行に膨らむだけで、外れていれば TypeError で落ちる。意図して使う制御文字の正規表現などは、行の直前に `// biome-ignore lint/<ルール>: <理由>` を書いて個別に抑える。

## 必須の規約

- **公式ドキュメントに明記されない挙動を決めたら、実装と同じ PR で `docs/fidelity.md` に追記する。** 挙動の前提を記録するという同ファイルの役割そのもので、PR テンプレートのチェックリスト項目でもある。
- **`npm run lint` と `npm run typecheck` と `npm run coverage` を green にしてから PR を出す。**カバレッジの閾値はラチェットで、**下げるときは理由を PR に書く**（黙って下げられるなら無いのと同じ）。
- PR では `ci.yml` が **Node 24** で `npm ci` → **lint** → typecheck → **coverage**（`npm test` ではなく `npm run coverage`。テストの失敗と閾値割れのどちらでも赤くなる。`engines.node` が `>=20` なので、ローカルが 20 系でも CI は 24 で通ること）。**main 宛の PR ではさらに** `security.yml`（`npm audit --audit-level=high` と gitleaks）が走り、**CI が green でもこちらが赤いことがある**。

## コードの約束

- **ESM**。**相対 import は拡張子 `.ts` を明示する**（例: `import { ok } from "./envelope.ts";`）。落とすと typecheck が `TS2835` で落ちる。
- `tsconfig.json` は `strict` / `noEmit` / `module` と `moduleResolution` が `NodeNext` / `target: ES2022`。
- **`src/` と `tests/` はディレクトリ構成を対応させる**（`src/engine/match.ts` → `tests/engine/match.test.ts`）。例外は `tests/structure.test.ts` が理由つきで持ち、ずれると落ちる。
- **テストから外へ要求を出さない。** `SessionStore` は `fetchCandles` を渡し忘れると本物の公開 API へ落ちるので、テストではスタブ（`tests/routes/helpers.ts` の `stubFetchCandles()` など）を渡すか `fillMode: "manual"` にする。忘れても `tests/network-guard.ts` が `undici` の口を塞いで**そのテストを落とす**（`fetch failed` ではなく「テストから外向きの fetch が呼ばれました」が出たらこれ）。ローカルのサーバへ話す必要があるときは `tests/server-process.ts` で起こして子プロセスから叩く。
- **互換ルート（`/v1/user/...`）は `src/routes/envelope.ts` の `ok()` / `err()` で封筒に包む。** 成功は `{ success: 1, data }`、失敗は `{ success: 0, data: { code } }`。code は同ファイルの `ErrorCode` から選ぶ（残高不足 `60001`、注文が見つからない `50009`）。登録は `src/server/http.ts` の `buildServer()`。
- **`/_control/` は bitbank API に無い実験用の口で、封筒に包まず素の JSON。** 失敗は HTTP ステータス（400 / 403 / 404 / 409、劣化後は 503）。`BITBANK_MOCK_CONTROL=1` のときだけ登録し、非ループバックには `X-Control-Token` を要求する。実装は `src/routes/control.ts`。
- **注文の単一の真実は `src/engine/state.ts` の `OrderRecord`。** 状態全体は `PaperState`（zod、`version: 3`）。
- **`SessionStore` の `_state` は `setState()` 以外から書き換えない。** private stream（`src/stream/`）は `SessionStore.onStateChange()` が渡す差し替えの前後の差からイベントを作るので、この口を通れば新しい経路にも通知が自動で付き、迂回すると stream に黙って流れない。WebSocket の口は `GET /_stream/private`（bitbank API には無い。公式は PubNub）で、挙動の正は `docs/fidelity.md` の「private stream」から始まる一連の節。
- **遷移関数を通る限り `src/engine/invariants.ts` の不変量は破れない**（一覧は `docs/fidelity.md` の「6 本の不変量」。移行してきた状態など例外も同ファイル）。**状態を変える変更を入れたら `tests/engine/invariants.test.ts` も確認する**（fast-check のプロパティテスト）。
- **コメントとドキュメントは日本語**で書く。

## 作業のしかた

- **`main` へ直接 push しない。** 指定されたブランチで作業する。
- **PR は明示的に指示されたときだけ作る。**
