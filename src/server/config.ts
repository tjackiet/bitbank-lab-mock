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
