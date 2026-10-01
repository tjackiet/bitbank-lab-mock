import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `src/` と `tests/` の対応を機械で見る（CLAUDE.md の「コードの約束」）。
 *
 * 規約そのものは短い——`src/engine/match.ts` のテストは `tests/engine/match.test.ts`。
 * ところが実際には例外が 4 つあり、**規約だけを読んだ人には例外が見えなかった**。
 * かといって CLAUDE.md に例外を並べると、規約より例外のほうが長くなる。
 *
 * そこで**例外はここが理由つきで持つ**。維持する場所を 1 つにする発想は
 * `src/server/degraded.ts` の経路分類（`assertRouteClassified()`）と同じである。
 *
 * このテストは 3 方向を見る。
 *
 * 1. `src/` のファイルに対応するテストがあること（無ければ下の許可リストに理由つきで載せる）
 * 2. `*.test.ts` に対応する `src/` があること（横断的なテストは許可リストへ）
 * 3. **許可リストが古くなっていないこと。** 例外に挙げたファイルに後からテストが付いたら、
 *    エントリを消すまで落ちる。これが無いと許可リストだけが増え続ける
 */

/**
 * `tests/` 固有のディレクトリ。`src/` 側に同名のディレクトリを作らせないためだけに持つ。
 *
 * **配下のテストを検査から外すためではない。** 一括で除外すると、ここへ置いた
 * 普通の単体テストが黙って対応検査をすり抜ける。`scenarios/` の各ファイルは
 * 下の `TEST_WITHOUT_SRC` に 1 件ずつ理由つきで載せてある。
 */
const TESTS_ONLY_DIRS = ["fixtures", "scenarios"];

/**
 * 対応するテストファイルを持たない `src/` のファイルと、その理由。
 *
 * **「テストが無い」ではなく「同名のテストファイルが無い」である。** 下の 4 つはいずれも
 * 別のファイルから実際に叩かれている。分けていないのは、単体で切り出すと
 * 呼び出し側の文脈が落ちて読みにくくなるためで、意図的な例外である。
 */
const SRC_WITHOUT_TEST: Record<string, string> = {
  "engine/types.ts": "型だけで実行時の振る舞いを持たない",
  "routes/format.ts":
    "整形は応答の形として見るほうが意味がある。`tests/routes/order-info.test.ts` と " +
    "`tests/routes/assets.test.ts` が、公式の応答表を写した `tests/routes/official-fields.ts` と" +
    "突き合わせて検証している",
  "routes/params.ts":
    "パラメータの解釈は wire 上の契約なので、返る error code で見る。" +
    "`tests/routes/active-orders.test.ts` と `tests/routes/trade-history.test.ts`（絞り込み）と " +
    "`tests/routes/create-order.test.ts`（発注パラメータ）が経路ごとに検証している",
  "server/http.ts":
    "`buildServer()` は組み立てだけで、見るべきは組み上がった挙動。" +
    "`tests/server/not-found.test.ts`（未登録パス）と `tests/server/degraded.test.ts`（劣化ガード）が担当する",
};

/**
 * 対応する `src/` のファイルを持たないテストと、その理由。
 *
 * いずれも**1 つのモジュールではなく、横断する性質**を見るテストである。
 */
const TEST_WITHOUT_SRC: Record<string, string> = {
  "structure.test.ts": "この対応表そのもの",
  "docs.test.ts":
    "`docs/fidelity.md` の参照と対応表の形、`README.md` の環境変数一覧を見る。" +
    "src の 1 モジュールに対応しない",
  "routes/pair-whitelist.test.ts": "ペアの実在性を検査する経路／しない経路を横断して見る",
  "routes/tick.test.ts": "互換ルートが必ず `SessionStore.tick()` を通ることを横断して見る",
  "routes/time-source.test.ts":
    "`src/routes/` の全ファイルが、記録する時刻を実時刻からではなく `SessionStore.now()` から" +
    "読むことを横断して見る",
  "server/not-found.test.ts":
    "経路が見つからない要求の応答を、互換ルートと `/_control/` の両方で見る",
  "scenarios/plan-a.test.ts": "結合シナリオ。発注から約定までを複数モジュールにまたがって通す",
  "scenarios/large-amount-fill.test.ts": "結合シナリオ。大きな数量での約定を端から端まで通す",
  "scenarios/private-stream.test.ts":
    "結合シナリオ。互換ルートと `/_control/` の操作が private stream に何を流すかを、" +
    "状態の変化の経路（発注・約定・取消・market の tick・劣化・切断）ごとに端から端まで通す",
  "scenarios/virtual-clock.test.ts":
    "結合シナリオ。仮想時計で、互換ルートと `/_control/` と private stream が記録する時刻を" +
    "端から端まで通す",
  "scenarios/example-script.test.ts":
    "`examples/scenario-plan-a.sh` を実プロセスのサーバへ流す。見る対象が src ではなく" +
    "リポジトリに置いた例のスクリプトそのもの",
  "network-guard.test.ts":
    "テスト基盤（`tests/network-guard.ts` と `tests/no-network.ts`）の検査。" +
    "外向きの fetch を止める番人が空振りしていないことを見る",
};

/** ディレクトリ配下の相対パスを再帰で集める。 */
function walk(root: string, dir = root): string[] {
  return readdirSync(join(root, dir === root ? "" : dir))
    .flatMap((name) => {
      // 論理パスは常に `/` で組む。`join()` は Windows で `\` を返すので、
      // 許可リストの鍵（`engine/types.ts`）と一致しなくなる。fs アクセスには join を使う。
      const rel = dir === root ? name : `${dir}/${name}`;
      return statSync(join(root, rel)).isDirectory() ? walk(root, rel) : [rel];
    })
    .sort();
}

const srcFiles = walk("src").filter((f) => f.endsWith(".ts"));
const testFiles = walk("tests").filter((f) => f.endsWith(".test.ts"));

/** `engine/match.ts` → `engine/match.test.ts`。 */
const testNameOf = (src: string) => src.replace(/\.ts$/, ".test.ts");
/** `engine/match.test.ts` → `engine/match.ts`。 */
const srcNameOf = (test: string) => test.replace(/\.test\.ts$/, ".ts");

describe("src/ と tests/ の対応", () => {
  it("導出が空振りしていない", () => {
    // 集め方を壊すと全部が黙って通るので、まず件数を見る。
    expect(srcFiles.length).toBeGreaterThan(20);
    expect(testFiles.length).toBeGreaterThan(15);
  });

  it("`src/` のファイルには同名のテストがあるか、理由つきで例外に載っている", () => {
    const missing = srcFiles.filter(
      (f) => !testFiles.includes(testNameOf(f)) && !(f in SRC_WITHOUT_TEST),
    );
    expect(missing, `tests/${missing.map(testNameOf).join(", tests/")} が無い`).toEqual([]);
  });

  it("`*.test.ts` には同名の `src/` があるか、理由つきで例外に載っている", () => {
    const orphan = testFiles.filter(
      (f) => !srcFiles.includes(srcNameOf(f)) && !(f in TEST_WITHOUT_SRC),
    );
    expect(orphan, `src/${orphan.map(srcNameOf).join(", src/")} が無い`).toEqual([]);
  });

  /**
   * 許可リストは**消えるための表**である。例外に挙げたファイルにテストが付いたら、
   * エントリを消すまでここが落ちる。放っておくと許可リストだけが増えて規約が形骸化する。
   */
  it("例外の許可リストに古いエントリが残っていない", () => {
    // 理由の無い例外を許さない。値が `string` なだけだと空文字でも通ってしまい、
    // 「理由つきで持つ」という前提が空洞になる。
    for (const [file, reason] of [
      ...Object.entries(SRC_WITHOUT_TEST),
      ...Object.entries(TEST_WITHOUT_SRC),
    ]) {
      expect(reason.trim(), `${file} の理由が空`).not.toBe("");
    }

    const solved = Object.keys(SRC_WITHOUT_TEST).filter((f) => testFiles.includes(testNameOf(f)));
    expect(solved, `テストが付いたので SRC_WITHOUT_TEST から消す: ${solved.join(", ")}`).toEqual(
      [],
    );

    const gone = Object.keys(SRC_WITHOUT_TEST).filter((f) => !srcFiles.includes(f));
    expect(gone, `もう存在しないので SRC_WITHOUT_TEST から消す: ${gone.join(", ")}`).toEqual([]);

    const paired = Object.keys(TEST_WITHOUT_SRC).filter((f) => srcFiles.includes(srcNameOf(f)));
    expect(
      paired,
      `対応する src ができたので TEST_WITHOUT_SRC から消す: ${paired.join(", ")}`,
    ).toEqual([]);

    const removed = Object.keys(TEST_WITHOUT_SRC).filter((f) => !testFiles.includes(f));
    expect(removed, `もう存在しないので TEST_WITHOUT_SRC から消す: ${removed.join(", ")}`).toEqual(
      [],
    );
  });

  it("`tests/` 固有のディレクトリは `src/` に対応物を持たない", () => {
    // `fixtures/` と `scenarios/` を `src/` に作ってしまったら、この規約の読み方が変わる。
    for (const d of TESTS_ONLY_DIRS) {
      expect(
        srcFiles.some((f) => f.startsWith(`${d}/`)),
        `src/${d}/ ができている`,
      ).toBe(false);
    }
  });
});
