import type { AssetKeyStyle } from "../routes/format.ts";
import type { PersistFailureMode } from "./degraded.ts";

export type FillMode = "market" | "manual";

export function isControlEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.BITBANK_MOCK_CONTROL === "1";
}

export function fillMode(env: NodeJS.ProcessEnv = process.env): FillMode {
  if (env.BITBANK_MOCK_FILL_MODE === "market") return "market";
  if (env.BITBANK_MOCK_FILL_MODE === "manual") return "manual";
  return isControlEnabled(env) ? "manual" : "market";
}

/**
 * 状態ファイルへの書き出しに失敗した後の振る舞い。**既定は `degrade`**。
 *
 * v0.1.0 は失敗しても何も断らなかった（`ignore` 相当）。安全側を既定にして、env は
 * 切るための逃げ道にする（`docs/plan-lab-mock.md` 10.5 の決定）。名前付きモードにして
 * あるのは、劣化が高くつくと分かったときに `exit`（プロセス停止）を第 3 の値として
 * 足せるようにするため。空文字と未知の値は既定に落とす（他の env 読み取りと同じ規則）。
 */
export function persistFailureMode(env: NodeJS.ProcessEnv = process.env): PersistFailureMode {
  return env.BITBANK_MOCK_PERSIST_FAILURE === "ignore" ? "ignore" : "degrade";
}

/**
 * 記録する時刻の出どころ。`real`（実時刻）か `virtual`（仮想時計）。
 */
export type ClockMode = "real" | "virtual";

/**
 * 時計のモード（`BITBANK_MOCK_CLOCK`）。**既定は `real`** で、`virtual` のときだけ仮想時計にする。
 * 空文字と未知の値は既定に落とす（他の env 読み取りと同じ規則）。
 *
 * 仮想時計を使えるのは **control 有効かつ manual モードのときだけ**で、それ以外と同時に
 * 指定されたら起動を断る（`virtualClockConflicts()`。`docs/plan-lab-mock.md` 17.2 の決定 24）。
 * ここは値を読むだけで、組み合わせは見ない。
 */
export function clockMode(env: NodeJS.ProcessEnv = process.env): ClockMode {
  return env.BITBANK_MOCK_CLOCK === "virtual" ? "virtual" : "real";
}

/**
 * 仮想時計と同時に指定できない設定の一覧（起動を断る理由）。仮想時計でなければ、または
 * 組み合わせが正しければ空。`src/index.ts` が状態ファイルに触れる前に呼び、空でなければ
 * 起動しない。
 *
 * **warn を出して仮想時計を切る、にはしない。** warn を見落とすと、時計を進めたつもりで
 * 実時刻が記録され、確かめようとしている時間窓の実験が黙って別の条件で走るため
 * （決定 24 の「あわせて決めること」）。
 *
 * - control が無効: 時計を動かす口（`POST /_control/clock`）が無い
 * - market モード: 足を実時刻の窓で公開 API から取るので、時計を実時刻から離すと取得の窓が
 *   意味を失う（control が無効なときの既定も market なので、control 無効だけでも両方が出る）
 */
export function virtualClockConflicts(env: NodeJS.ProcessEnv = process.env): string[] {
  if (clockMode(env) !== "virtual") return [];
  const conflicts: string[] = [];
  if (!isControlEnabled(env)) {
    conflicts.push("BITBANK_MOCK_CONTROL が 1 ではない（時計を動かす /_control/clock が無い）");
  }
  if (fillMode(env) !== "manual") {
    conflicts.push(
      "約定のさせ方が market である（BITBANK_MOCK_FILL_MODE=market か、control 無効時の既定）",
    );
  }
  return conflicts;
}

export function listenHost(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BITBANK_MOCK_HOST) return env.BITBANK_MOCK_HOST;
  return isControlEnabled(env) ? "127.0.0.1" : "0.0.0.0";
}

export function controlToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = env.BITBANK_MOCK_CONTROL_TOKEN;
  return token ? token : undefined;
}

/**
 * private stream の `asset_update` のキーの綴り。**既定は `camel`**で、`snake` のときだけ
 * snake_case にする。空文字と未知の値は既定に落とす（他の env 読み取りと同じ規則）。
 *
 * 切り替えられるようにしてあるのは、**公式が同じ節の中で割れていて、どちらが本物か
 * 確かめていない**ためである（`docs/fidelity.md` の「private stream の `asset_update` のキー」）。
 * 利用側は両方の綴りでパーサを流して確かめられる。
 */
export function streamAssetKeys(env: NodeJS.ProcessEnv = process.env): AssetKeyStyle {
  return env.BITBANK_MOCK_STREAM_ASSET_KEYS === "snake" ? "snake" : "camel";
}
