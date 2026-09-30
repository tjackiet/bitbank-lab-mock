import type { Candle } from "../engine/candles.ts";
import { defaultFetchCandles } from "../engine/candles.ts";
import { runTick } from "../engine/match.ts";
import { defaultStatePath, loadState, saveState } from "../engine/persist.ts";
import {
  activeOrders,
  DEFAULT_TAKER_FEE_RATE,
  freshState,
  nowIso,
  type PaperState,
  pairAssets,
} from "../engine/state.ts";
import type { FetchCandles, Logger, Result } from "../engine/types.ts";
import { noopLogger } from "../engine/types.ts";
import { type FillMode, fillMode, persistFailureMode } from "../server/config.ts";
import type { PersistFailureMode } from "../server/degraded.ts";

const LATEST_LOOKBACK_MS = 5 * 60_000;

/**
 * 状態ファイルへの書き出しが今どうなっているか。`GET /_control/state` に添えて返す。
 *
 * 2xx だけでは書き込みの成否を判定できない（`write()` は失敗しても throw しない）ので、
 * 警告ログを読む以外に確かめる手段が無かった。実験中にここを見れば、応答を返した注文が
 * 再起動後に消える状態になっていないかを機械的に判定できる。
 *
 * `lastError` は**成功しても消さない**。一度でも失敗したなら、その実験で取った記録は
 * 疑ってかかる必要があるため。今まさに失敗し続けているかどうかは
 * `consecutiveFailures > 0` で見る。
 */
export type PersistHealth = {
  /** 直近の書き込み失敗。まだ一度も失敗していなければ `null`。 */
  lastError: { at: string; message: string } | null;
  /** 直近の書き込みが連続で失敗した回数。1 回でも成功すると 0 に戻る。 */
  consecutiveFailures: number;
};

/**
 * 足の取得が今どうなっているか。`GET /_control/state` に `persist` と並べて返す。
 *
 * 市場モード（`BITBANK_MOCK_FILL_MODE=market`）で足の取得に失敗しても、`tick()` はそれを
 * warn に落として先へ進み、互換ルートは通常どおり成功応答を返す。失敗した窓は取り直さない
 * ので、**約定が起きないという結果だけからは「価格が届いていない」と「足が取れていない」を
 * 区別できない。** ここを見れば機械的に区別できる。
 *
 * **ペアごとには分けず、store 全体で 1 つ持つ。** `tick()` はペアごとに取りに行くので分けることも
 * できたが、そうしない理由が 3 つある。
 *
 * - 取得先は `BITBANK_PUBLIC_BASE_URL` の 1 つで、失敗はふつう全ペアに同時に効く
 * - ペアごとにすると応答のキーが状態ファイル由来のペア名になる（`persist` と並べて読める
 *   固定のキーでなくなる）。注文が消えたペアの項目をいつ捨てるかも決めなければならない
 * - どのペアで失敗したかは `lastError.message` に入る URL から読める
 *
 * **代償は連続失敗数の意味が粗くなること**である。複数のペアのうち 1 つだけが失敗し続けて
 * いると、他のペアの成功で `consecutiveFailures` は 0 に戻る（`lastError` は消さないので
 * 「一度でも失敗したか」は残る）。
 */
export type CandlesHealth = {
  /**
   * 直近の取得失敗（時刻と理由）。まだ一度も失敗していなければ `null`。
   * **成功しても消さない**（`persist` と同じ。「一度でも失敗したか」が残る）。
   */
  lastError: { at: string; message: string } | null;
  /**
   * 取得が連続で失敗した回数。1 回でも成功すると 0 に戻る。
   *
   * 数えるのは**完了した順**である（互換ルートから並行に走る取得は、開始の順に完了すると
   * は限らない）。「最後に完了した取得が失敗だったか」は正しく出るが、開始の順に数えた
   * 回数とは限らない。下の 2 つの時刻はそうならないよう順序を見て記録する。
   */
  consecutiveFailures: number;
  /**
   * 直近に取得へ成功した時刻。まだ一度も成功していなければ `null`。
   *
   * `persist` には無いが、こちらには要る——「いつまでは足が取れていたか」が、約定が止まった
   * 時点の特定に直結する。`lastTickAt` と同じ時計で記録するので、並べて読める。
   */
  lastSuccessAt: string | null;
  /**
   * 約定のさせ方（`BITBANK_MOCK_FILL_MODE`）。**上の 3 つが初期値のままである理由を
   * 読み分けるために持つ。**
   *
   * `manual` のとき `tick()` は足を取りに行かないので、初期値は「取りに行ったが何も起きて
   * いない」ではなく「`tick()` は取りに行っていない」を意味する。これが無いと、`market` で
   * まだ active な注文が無いだけの状態と見分けが付かない。ただし `manual` でも成行の発注は
   * `getLatestPrice()` から取りに行くので、`manual` のまま失敗が記録されることはある。
   */
  fillMode: FillMode;
};

/**
 * 記録済みの時刻（まだ無ければ `null`）に対して、この取得のほうが古くないか。
 *
 * 足の取得は互換ルートから並行に走るので、**開始の順に完了するとは限らない**——遅い要求の
 * 応答が、後から始まって先に返った要求の後に着く。素直に上書きすると `lastSuccessAt` が
 * 巻き戻り（「いつまで足が取れていたか」を実際より手前に見せる）、`lastError` が古い失敗で
 * 塗り替わる。ここで弾けば、どちらも**実際にあった取得のうち最も新しいもの**を指したままに
 * なる。比べるのは取得範囲の終端（`toMs`）で、記録済みの側は自分で作った ISO 文字列なので
 * `Date.parse` は往復して一致する。
 *
 * 同じミリ秒なら通す（後から完了したほうの理由を載せる）。
 */
function isNotOlderThan(ms: number, recorded: string | null): boolean {
  return recorded === null || ms >= Date.parse(recorded);
}

/**
 * 状態の差し替え 1 回ぶん。`SessionStore.onStateChange()` の購読者へ渡す。
 *
 * **`prev` と `next` は差し替えの直前と直後の状態そのもの**で、途中を畳んでいない。
 * 状態を変える経路はどれも `SessionStore` の中の 1 か所（`setState()`）を通るので、
 * 購読者は経路ごとの戻り値を知らなくても「何が変わったか」を 2 つの状態の差から読める。
 * private stream（`src/stream/`）はこれを使う（`docs/plan-lab-mock.md` 16 節）。
 *
 * - `update`: 遷移関数を通った変化（`commit()` と `tick()`）と、テストが使う `replace()`
 * - `reset`: 状態を丸ごと差し替えた（`POST /_control/reset`）。注文も約定も採番も捨てて
 *   やり直すので、**差分として読んではいけない**——注文 id が 1 から配り直され、
 *   消えた注文を表す手段も公式のメッセージに無い
 */
export type StateChange = {
  prev: PaperState;
  next: PaperState;
  kind: "update" | "reset";
};

/**
 * 状態の差し替えを受け取る関数。**同期に呼ばれ、戻るまで次の差し替えは起きない。**
 * 投げても状態の差し替えは取り消されない（`setState()` が握り潰して warn に落とす）。
 */
export type StateListener = (change: StateChange) => void;

export type SessionStoreOptions = {
  fetchCandles?: FetchCandles;
  path?: string | null;
  feeRate?: number;
  logger?: Logger;
  fillMode?: FillMode;
  persistFailureMode?: PersistFailureMode;
  /**
   * 時計（エポックミリ秒を返す関数）。`SessionStore.now()` の中身になる。既定は実時刻
   * （呼ぶたびに `Date.now()` を読む）。
   */
  now?: () => number;
};

export class SessionStore {
  private _state: PaperState;
  private readonly fetchCandles: FetchCandles;
  private readonly path: string | null;
  readonly feeRate: number;
  readonly fillMode: FillMode;
  readonly persistFailureMode: PersistFailureMode;
  private readonly logger: Logger;
  /** 時計。`now()` で読む。 */
  private readonly clock: () => number;
  /** 直列化した書き込みの末尾。次の書き込みはこれが解決してから始める。 */
  private persistTail: Promise<void> = Promise.resolve();
  /** 予約済みでまだ始まっていない書き込み。重なった persist() はここへ合流する。 */
  private persistPending: Promise<void> | null = null;
  /** 書き出しの失敗の記録。`persistHealth()` で読む。 */
  private _persistHealth: PersistHealth = { lastError: null, consecutiveFailures: 0 };
  /** 足の取得の成否の記録。`candlesHealth()` で読む。`fillMode` が決まってから組み立てる。 */
  private _candlesHealth: CandlesHealth;
  /** 状態の差し替えの購読者。`onStateChange()` で足し、戻り値の関数で外す。 */
  private readonly stateListeners = new Set<StateListener>();

  constructor(state: PaperState, opts: SessionStoreOptions = {}) {
    this._state = state;
    this.fetchCandles = opts.fetchCandles ?? defaultFetchCandles();
    this.path = opts.path === undefined ? defaultStatePath("default") : opts.path;
    this.feeRate = opts.feeRate ?? DEFAULT_TAKER_FEE_RATE;
    this.fillMode = opts.fillMode ?? fillMode();
    this.persistFailureMode = opts.persistFailureMode ?? persistFailureMode();
    this.logger = opts.logger ?? noopLogger;
    // `Date.now` の参照をここで固定せず、呼ぶたびに読む。固定すると、store を作った後に
    // `vi.useFakeTimers()` で `Date` を差し替えたテストで、この時計だけが実時刻のまま残る。
    this.clock = opts.now ?? (() => Date.now());
    this._candlesHealth = {
      lastError: null,
      consecutiveFailures: 0,
      lastSuccessAt: null,
      fillMode: this.fillMode,
    };
  }

  state(): PaperState {
    return this._state;
  }

  /**
   * いまの時刻（エポックミリ秒）。**状態に記録する時刻の出どころはここ 1 か所に寄せる**
   * （`docs/plan-lab-mock.md` 17.3 の PR C1）。仮想時計（PR C2）はこの中身だけを差し替える。
   *
   * ここから読むもの:
   *
   * - 互換ルートの発注・取消の時刻（`ordered_at` / `canceled_at`。`src/routes/create-order.ts`・
   *   `src/routes/cancel-order.ts`）
   * - `/_control/` の fill の約定時刻と reject の時刻（`src/routes/control.ts`）
   * - `tick()` と `getLatestPrice()` の `nowMs` の既定値
   *
   * **ここから読まないもの**（実時刻のまま）:
   *
   * - `POST /_control/tick` と `POST /_control/clock` の `realNowMs`。「実時刻から 24 時間」という
   *   上限の基準なので、時計そのものからは測らない。**この値は上限のほかに、tick の前進の下限
   *   （`max(realNowMs, lastTickAt + 60 秒)`）と、clock の本文を省いたときの行き先・`updatedAt` にも
   *   使っている。** 仮想時計でこれらをどう扱うかは PR C2 で決める（17.2 の決定 25〜27）
   * - `freshState()` の時刻（状態ファイルが無いときと `POST /_control/reset`）。reset で時計は
   *   実時刻に戻る（`docs/plan-lab-mock.md` 17.2 の決定 25）
   * - 書き出し失敗の記録時刻（`persistHealth()` の `lastError.at`）。診断用なので実時刻が正しい
   *
   * `src/routes/` が `Date.now()` / `new Date()` を直に呼ばないことは
   * `tests/routes/time-source.test.ts` が見る。
   */
  now(): number {
    return this.clock();
  }

  /**
   * 状態を差し替える（書き出しはしない）。購読者（`onStateChange()`）には通知する。
   */
  replace(next: PaperState): void {
    this.setState(next, "update");
  }

  /**
   * 状態の差し替えを購読する。戻り値の関数を呼ぶと外れる。
   *
   * **状態を変える経路はすべてここへ通知される**——`commit()`（互換ルートと `/_control/` の
   * fill / tick / clock）、`reset()`（`POST /_control/reset`）、`tick()`（market モードの
   * 約定と時計の前進）。経路ごとに通知を足す形にしないのは `commit()` と同じ理屈で、
   * 新しい経路が通知を書き忘れても**黙って抜ける**ことが無いようにするためである
   * （`docs/plan-lab-mock.md` 14.1 の (3) が、経路ごとの戻り値では一括取消と `tick()` の
   * 個々の変化を復元できないことを記録している）。
   *
   * 通知は**メモリへ反映した直後**に同期で行う。書き出し（`persist()`）の成否を待たない
   * （`docs/plan-lab-mock.md` 16 節の決定 14）。
   */
  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /**
   * `_state` を書き換える唯一の口。書き換えてから購読者へ通知する。
   *
   * **購読者の例外で状態の差し替えを止めない。** 差し替えは既に済んでおり、ここで投げると
   * `commit()` が `persist()` へ進まずにルートが封筒でない 500 を返す——発注はメモリ上で
   * 成立しているのに失敗が返り、再送が二重注文になる（`write()` が EPIPE を握り潰すのと
   * 同じ理由）。warn に落とし、warn 自体が投げても握り潰す。
   */
  private setState(next: PaperState, kind: StateChange["kind"]): void {
    const prev = this._state;
    this._state = next;
    if (prev === next) return;
    for (const listener of this.stateListeners) {
      try {
        listener({ prev, next, kind });
      } catch (e) {
        try {
          const message = e instanceof Error ? e.message : String(e);
          this.logger.warn(`state listener failed: ${JSON.stringify(message)}`);
        } catch {
          // ログに出せなくても状態は既に差し替わっている。ここで投げる先は無い。
        }
      }
    }
  }

  /**
   * 状態を差し替えて状態ファイルへ書き出す。**状態を変えるルートは必ずこれを通す。**
   *
   * `replace()` と `persist()` を別々に呼ぶ形だと、書き出しを呼び忘れた経路が
   * 「応答は 2xx なのに再起動で消える」状態を作る。docs/fidelity.md の「状態の永続化」は
   * この非対称を記録しているが、記録しているのは persist が**失敗した**場合であって、
   * 呼び忘れはその対象ですらない（失敗なら `persistHealth()` と劣化モードで検知できるが、
   * 呼んでいなければどちらも動かない）。1 つの操作にしておけば呼び忘れようがない。
   *
   * `persist()` と同じく、書き出しに失敗しても throw しない（失敗は `_persistHealth` へ
   * 記録して warn に出すだけ）。したがって `await` が返ったことは書き出しの成功を意味しない。
   *
   * **`replace()` は公開のまま残す。** `SessionStore` の書き込みの直列化を検査するテストが、
   * 書き出しと切り離して状態だけを差し替える必要があるため（tests/store/session.test.ts）。
   */
  async commit(next: PaperState): Promise<void> {
    this.replace(next);
    await this.persist();
  }

  /**
   * 状態を丸ごと差し替えて書き出す（`POST /_control/reset`）。書き出しの扱いは `commit()` と同じ。
   *
   * `commit()` と分けてあるのは購読者に `kind: "reset"` を渡すため**だけ**である。reset の後は
   * 注文 id が 1 から配り直されるので、差分として読むと「前の注文 1」と「新しい注文 1」が
   * 同じ注文に見える。private stream はこれを受けて接続を切る（`docs/fidelity.md` の
   * 「private stream と状態の初期化」）。
   */
  async reset(next: PaperState): Promise<void> {
    this.setState(next, "reset");
    await this.persist();
  }

  /**
   * 状態ファイルへの書き出しが今どうなっているか（`PersistHealth`）。
   *
   * `path` を持たない store（テストや `path: null`）は書き出し自体をしないので、
   * 初期値のまま動かない。
   */
  persistHealth(): PersistHealth {
    return this._persistHealth;
  }

  /**
   * 足の取得が今どうなっているか（`CandlesHealth`）。
   *
   * 取りに行かない設定（`fillMode: "manual"`）の store は `tick()` から取得しないので、
   * `getLatestPrice()`（成行の発注）を通らない限り初期値のまま動かない。初期値かどうかで
   * 判断を誤らないよう、`fillMode` を同じオブジェクトに入れてある。
   */
  candlesHealth(): CandlesHealth {
    return this._candlesHealth;
  }

  /**
   * 足を取りに行く唯一の口。成否を `_candlesHealth` へ記録してから、結果をそのまま返す。
   *
   * `this.fetchCandles` を直に呼ぶ経路を残さないのは `commit()` と同じ理屈で、記録の
   * 呼び忘れを構造的に無くすためである。取りに行く経路は 2 つある——`tick()` の窓ごとの
   * 取得と、成行の発注が使う `getLatestPrice()`——が、利用側の問いは「足が取れているか」で
   * あって「どちらの経路から取ったか」ではないので、同じ health へ記録する。
   *
   * **結果は書き換えない。** 失敗をどう扱うか（`tick()` は warn に落として先へ進む、
   * `getLatestPrice()` は `null` を返す）は呼び出し側のままで、ここは見えるようにするだけ。
   * 再取得もしない（失敗した窓を取り直すかは別に判断する。`docs/fidelity.md` の
   * 「足の取得の健全性」）。
   *
   * 記録する時刻は取得範囲の終端（`toMs`）。どちらの呼び出し側でもその回の `nowMs` なので、
   * `lastTickAt` と同じ基準になり、並べて読める。
   *
   * **時刻の 2 つは巻き戻さない**（`isNotOlderThan`）。互換ルートから並行に走る取得は開始の
   * 順に完了するとは限らないので、古い取得が後から着いても `lastSuccessAt` と `lastError` は
   * 最も新しいものを指したままにする。**連続失敗数には同じ番人を置かない**——「新しいほうが
   * 先に完了したら古い失敗を捨てる」形にすると、失敗を 1 件も記録しないまま
   * `lastError` が `null` のままになる経路ができ、「一度でも失敗したか」が残るという
   * この health の約束を破る。数えるのは完了した順のままでよい。
   */
  private async fetchCandlesTracked(
    pair: string,
    fromMs: number,
    toMs: number,
  ): Promise<Result<Candle[]>> {
    const r = await this.fetchCandles(pair, fromMs, toMs);
    const at = new Date(toMs).toISOString();
    const health = this._candlesHealth;
    if (r.success) {
      this._candlesHealth = {
        ...health,
        consecutiveFailures: 0,
        lastSuccessAt: isNotOlderThan(toMs, health.lastSuccessAt) ? at : health.lastSuccessAt,
      };
      return r;
    }
    this._candlesHealth = {
      ...health,
      lastError: isNotOlderThan(toMs, health.lastError?.at ?? null)
        ? { at, message: r.error }
        : health.lastError,
      consecutiveFailures: health.consecutiveFailures + 1,
    };
    return r;
  }

  /**
   * 書き出しに失敗して劣化しているか。劣化中は状態を変える要求を断り、読み取りは生かす。
   *
   * 判定に使うのは `lastError`（**成功しても消さない**）であって連続失敗数ではない。
   * 一度でも書けなかったなら、そこから先の注文は状態ファイルと食い違い得るので、
   * その実験は続けさせない。**復帰手段は用意していない**（ディスクを直す →
   * `GET /_control/state` でシナリオを読み出す → 再起動。`docs/plan-lab-mock.md` 10.5）。
   *
   * `BITBANK_MOCK_PERSIST_FAILURE=ignore` なら常に偽（v0.1.0 の挙動）。
   */
  isDegraded(): boolean {
    return this.persistFailureMode === "degrade" && this._persistHealth.lastError !== null;
  }

  async tick(nowMs: number = this.now()): Promise<Map<string, Candle[]>> {
    const result = new Map<string, Candle[]>();
    if (this.fillMode === "manual") return result;
    // 劣化中は約定させない。読み取りは生かすが、tick は読み取りルートの先頭から呼ばれるので、
    // 止めないと「読むたびにメモリだけ進み、状態ファイルとの差が開く」ことになる。
    // lastTickAt / updatedAt の上書きも状態の変更なので、ここで丸ごと抜ける。
    if (this.isDegraded()) return result;
    const pairs = new Set(activeOrders(this._state).map((o) => o.pair));
    const lastMs = Date.parse(this._state.lastTickAt);
    const tickFrom = this._state.lastTickAt;
    // `/_control/tick` で進めた lastTickAt が実時刻より先にあると、取得範囲
    // (lastMs, nowMs) が逆転する。逆転した範囲で外へ問い合わせても、返った足は
    // runTick の窓（fromMs = min(lastTickAt, nowMs) 以上 nowMs 以下）から全部外れて
    // 1 本も約定しない。無駄な問い合わせなので取得ごと飛ばし、黙って止まらないよう
    // 警告を出す（この後 lastTickAt は nowMs で上書きされるので、次の tick は通る）。
    // ログには生の値を出さない（改行・制御文字で行を割られないよう JSON で包む）。
    const clockAhead = lastMs > nowMs;
    if (clockAhead && pairs.size > 0) {
      this.logger.warn(
        `tick: lastTickAt ${JSON.stringify(tickFrom)} is ahead of now ` +
          `${JSON.stringify(new Date(nowMs).toISOString())}; skipping candle fetch`,
      );
    }
    let totalFilled = 0;
    for (const pair of pairs) {
      if (clockAhead) {
        result.set(pair, []);
        continue;
      }
      // 状態ファイルから読んだ注文のペアは検証を通っていない（PaperStateSchema は文字種を
      // 見ない）。文字種が不正なペアは外向きに問い合わせても意味が無く、足が返ってくると
      // fillOrder が INVALID_PAIR を返して runTick ごと失敗する（約定が 1 件も進まない）。
      // ここで落として、無駄な問い合わせと空振りの tick をどちらも避ける。
      // ログには生の pair を出さない（改行・制御文字で行を割られないよう JSON で包む）。
      if (!pairAssets(pair)) {
        this.logger.warn(`tick: skipping malformed pair ${JSON.stringify(pair)}`);
        result.set(pair, []);
        continue;
      }
      const r = await this.fetchCandlesTracked(pair, lastMs, nowMs);
      if (!r.success) {
        // 失敗しても**ここでの扱いは変えない**——warn に落として次のペアへ進み、この後
        // lastTickAt を現在時刻へ進めるので、失敗した窓は二度と取りに行かない。互換ルートは
        // 通常どおり成功応答を返す。**見えるようにするのは応答ではなく `candlesHealth()`**
        // （`GET /_control/state` の `candles`）の側である。
        // 理由は JSON で包む。`fetchOneDay()` のメッセージは取得先の URL を生のまま含み、
        // URL には BITBANK_PUBLIC_BASE_URL 由来の値が入るので、包まないと改行でログ行を
        // 割られる（docs/fidelity.md の「ログに出す利用者由来の値」）。pair はすぐ上の
        // pairAssets を通っているので文字種は安全だが、揃えて包む。
        this.logger.warn(
          `tick: fetchCandles failed for ${JSON.stringify(pair)}: ${JSON.stringify(r.error)}`,
        );
        result.set(pair, []);
        continue;
      }
      result.set(pair, r.data);
      const sr = runTick(
        { ...this._state, lastTickAt: tickFrom },
        {
          candles: r.data,
          nowMs,
          pair,
          feeRate: this.feeRate,
          logger: this.logger,
        },
      );
      if (!sr.success) {
        this.logger.warn(`tick: runTick failed for ${pair}: ${sr.error}`);
        continue;
      }
      totalFilled += sr.data.filled.length;
      this.setState(sr.data.state, "update");
    }
    const ts = new Date(nowMs).toISOString();
    this.setState({ ...this._state, lastTickAt: ts, updatedAt: ts }, "update");
    // 約定が無いときは書かない（互換ルートは読み取りでも tick を回すので、毎回書くと
    // 状態ファイルへの書き込みが要求ごとに起きる）。ただし時計が先にあった回だけは、
    // ここで実時刻へ戻した lastTickAt を残す。残さないと、再起動後にファイルから
    // 未来の時計を読み直して同じ空振りを繰り返す。戻した後は clockAhead が偽になるので、
    // この書き込みが続くことはない。
    if (totalFilled > 0 || clockAhead) await this.persist();
    return result;
  }

  /**
   * 直近の終値。成行の発注（`POST /v1/user/spot/order`）が約定価格に使う。
   *
   * `null` を返す経路は 2 つ（取得の失敗と、窓に足が 1 本も無いこと）あり、呼び出し側は
   * どちらも封筒の `70001` に潰す。**どちらだったかは `candlesHealth()` で見分ける**
   * （取得の失敗ならそこに記録が残る）。`fillMode` が `manual` でもここは取りに行く。
   */
  async getLatestPrice(pair: string, nowMs: number = this.now()): Promise<number | null> {
    const r = await this.fetchCandlesTracked(pair, nowMs - LATEST_LOOKBACK_MS, nowMs);
    if (!r.success || r.data.length === 0) return null;
    return r.data.reduce((a, b) => (a.timestamp >= b.timestamp ? a : b)).close;
  }

  /**
   * 状態ファイルへ書き出す。saveState 自体は一時ファイル + rename で原子的だが、
   * 複数の書き込みが重なると古いスナップショットを持った rename が後から着地して
   * 状態が巻き戻る。ここで直列化して、そうならないようにする。
   *
   * 保証: await が返った時点で、ファイルは呼び出し時点の状態と同じか、それより
   * 新しい状態を反映している。書き込みの開始は必ず persist() の呼び出しより後で、
   * そのとき `this._state` を読むため、呼び出し時点の状態を取りこぼすことはない。
   *
   * 重なった呼び出しは 1 本にまとめる（途中のスナップショットは捨てる）。
   * ただし最後の 1 本は必ず着地する。
   */
  async persist(): Promise<void> {
    if (!this.path) return;
    // 予約済みの書き込みがあるなら、それを待てば自分より新しい状態が書かれる。
    if (this.persistPending) return this.persistPending;
    // 直前の書き込みが失敗しても連鎖は止めない（失敗は write() が warn 済み）。
    const pending = this.persistTail
      .catch(() => {})
      .then(() => {
        // 実書き込みへ移る前に予約を解除する。以降の persist() は次の 1 本を予約する。
        if (this.persistPending === pending) this.persistPending = null;
        return this.write();
      });
    this.persistPending = pending;
    this.persistTail = pending;
    return pending;
  }

  /**
   * 直列化された書き込みの実体。`persist()` からのみ呼ぶ。
   *
   * `saveState` は同期的に JSON 化するので、ここで読んだ `this._state` がそのまま着地する。
   * 書き込みに失敗しても throw しない。`_persistHealth` へ記録して warn を出すだけである。
   * ルートは `await store.persist()` の戻りを見ていないので、ここで投げるとハンドラの
   * 未捕捉例外になり、封筒でない 500 が返る。
   *
   * **既定（`BITBANK_MOCK_PERSIST_FAILURE=degrade`）では、この失敗の引き金になった要求も
   * 断る**（`buildServer()` の `preSerialization` が応答を差し替える）。`write()` は互換ルートと
   * `/_control/` の両方から呼ばれるので、断り方も 2 通りある——互換ルートは封筒の `70001`、
   * `/_control/` は素の JSON + 503 `PERSIST_DEGRADED`（`src/server/degraded.ts` の
   * `degradedResponse()`）。
   * メモリ上の注文は巻き戻さないので、応答は失敗・メモリには残る、という食い違いが残る。
   * `ignore` を選んだときだけ 2xx が返り、その注文は再起動後に消える。
   * どちらも `docs/fidelity.md` の「状態の永続化」の節に記録してある。
   * 呼び出し側がそれを検知する手段が `persistHealth()` であり、`GET /_control/state` の
   * `persist` として出る。
   */
  private async write(): Promise<void> {
    if (!this.path) return;
    // saveState は同期的に JSON 化するので、ここで読んだ状態がそのまま着地する。
    // logger は、書き込みは成立したがディレクトリの fsync に失敗した場合の warn に使う。
    const r = await saveState(this.path, this._state, { logger: this.logger });
    if (r.success) {
      this._persistHealth = { ...this._persistHealth, consecutiveFailures: 0 };
      return;
    }
    // 記録は warn より先に行い、warn が投げても握り潰す。閉じた標準出力への console.warn は
    // EPIPE で投げるので（`npm run dev | head`）、包まないと **発注はメモリ上で成立している
    // のに、ルートが封筒でない 500 を返す**（実測: `{"statusCode":500,"code":"EPIPE",...}`）。
    // クライアントは失敗と見て再送し、二重注文になる。書き込みが失敗しても 2xx を返すのが
    // ここの約束（docs/fidelity.md の「状態の永続化」）で、ログに出せなかったことで
    // その約束を破ってはならない。saveState 側も同じ扱い。
    //
    // 時刻は `this.now()` ではなく実時刻（`nowIso()`）で記録する。診断のための記録で、
    // 「いつディスクに書けなかったか」は時計をどこへ動かしていても実時刻で読めるべきため。
    this._persistHealth = {
      lastError: { at: nowIso(), message: r.error },
      consecutiveFailures: this._persistHealth.consecutiveFailures + 1,
    };
    try {
      // エラーメッセージは JSON で包む。fs のエラーは対象のパスを生のまま含み
      // （`rename '/a\nb.tmp' -> '/a\nb'`）、パスは BITBANK_MOCK_STATE_PATH 由来なので、
      // 包まないと改行でログ行を割られる。
      this.logger.warn(`persist failed: ${JSON.stringify(r.error)}`);
    } catch {
      // 失敗は既に `_persistHealth` へ記録済みなので、ログに出せなくても見る手段は残る。
    }
  }
}

/**
 * 状態ファイルを読んで SessionStore を作る。ファイルが無いときだけ初期状態で始める。
 *
 * 読み込みが失敗したら throw して起動を止める（fail-closed）。壊れた JSON・スキーマ違反に
 * 加えて、不変量を破る v3 の状態と、不変量の前提（id の一意性・採番と既存 id の整合・
 * `startAmount > 0`）を破る v3 の状態も失敗になる。判定は `loadState` が行い、不変量 6 の
 * 拘束額は手数料込みなので、SessionStore と同じ手数料率とロガーを渡す。
 */
export async function loadOrInitDefault(
  initialJpy: number,
  opts: SessionStoreOptions = {},
): Promise<SessionStore> {
  const path = opts.path === undefined ? defaultStatePath("default") : opts.path;
  let state: PaperState;
  if (path) {
    // 不変量 6 は手数料込みの拘束額を見るので、SessionStore と同じ手数料率で検査する。
    const r = await loadState(path, { feeRate: opts.feeRate, logger: opts.logger });
    if (!r.success) throw new Error(r.error);
    state = r.data ?? freshState(initialJpy);
  } else {
    state = freshState(initialJpy);
  }
  return new SessionStore(state, opts);
}
