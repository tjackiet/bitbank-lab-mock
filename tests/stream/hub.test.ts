import { describe, expect, it, vi } from "vitest";
import type { PaperState } from "../../src/engine/state.ts";
import { placeOrder } from "../../src/engine/transitions.ts";
import { SessionStore } from "../../src/store/session.ts";
import { type PrivateStreamMessage, stateChangeMessages } from "../../src/stream/events.ts";
import {
  DEFAULT_HOLD_LIMIT,
  type DeliveryPolicy,
  DISCONNECT_CLOSE_CODE,
  DISCONNECT_CLOSE_REASON,
  PrivateStreamHub,
  RESET_CLOSE_CODE,
  RESET_CLOSE_REASON,
  type StreamClient,
} from "../../src/stream/hub.ts";
import { buildState } from "../engine/helpers.ts";
import { stubFetchCandles } from "../routes/helpers.ts";

const T = "2026-01-01T00:00:00.000Z";

/** 書き出さず、足も取りに行かない store。料率 0 にして拘束額を読みやすくする。 */
function newStore(state: PaperState = buildState()) {
  return new SessionStore(state, {
    path: null,
    fillMode: "manual",
    fetchCandles: stubFetchCandles({}),
    feeRate: 0,
  });
}

/** 受け取ったものを溜めるだけの購読者。 */
function recorder() {
  const sent: PrivateStreamMessage[] = [];
  const closed: Array<{ code: number; reason: string }> = [];
  const client: StreamClient = {
    send: (text) => sent.push(JSON.parse(text)),
    close: (code, reason) => closed.push({ code, reason }),
  };
  return { client, sent, closed };
}

/** 指値を 1 本置いた次の状態（発注 1 回ぶんの差し替え）。 */
function placed(state: PaperState): PaperState {
  const r = placeOrder(
    state,
    { pair: "btc_jpy", side: "buy", type: "limit", amount: 0.001, price: 5_000_000 },
    T,
    undefined,
    0,
  );
  if (!r.success) throw new Error(r.error);
  return r.data.state;
}

describe("PrivateStreamHub", () => {
  it("差し替えから作ったメッセージを、全員へ同じ順で送る", () => {
    const store = newStore();
    const hub = new PrivateStreamHub(store, { assetKeys: "camel" });
    hub.start();
    const a = recorder();
    const b = recorder();
    hub.addClient(a.client);
    hub.addClient(b.client);

    const prev = store.state();
    const next = placed(prev);
    store.replace(next);

    const expected = stateChangeMessages(prev, next, { feeRate: 0, assetKeys: "camel" });
    expect(expected.length).toBeGreaterThan(0);
    expect(a.sent).toEqual(expected);
    expect(b.sent).toEqual(expected);
  });

  it("購読者がいなければメッセージを作らない（配信方針も呼ばない）", () => {
    const store = newStore();
    const policy = vi.fn<DeliveryPolicy>((ms) => ms);
    const hub = new PrivateStreamHub(store, { assetKeys: "camel", deliveryPolicy: policy });
    hub.start();
    store.replace(placed(store.state()));
    expect(policy).not.toHaveBeenCalled();
  });

  it("配信方針を通した列を送る（障害注入の差し込み口）", () => {
    const store = newStore();
    // 逆順にして、先頭をもう 1 度送る。重複と順序入替を同時に起こす。
    const policy: DeliveryPolicy = (ms) => {
      const reversed = [...ms].reverse();
      return reversed.length > 0 ? [...reversed, reversed[0]] : reversed;
    };
    const hub = new PrivateStreamHub(store, { assetKeys: "camel", deliveryPolicy: policy });
    hub.start();
    const r = recorder();
    hub.addClient(r.client);
    store.replace(placed(store.state()));
    expect(r.sent.map((m) => m.message.method)).toEqual([
      "asset_update",
      "spot_order_new",
      "asset_update",
    ]);
  });

  it("reset では何も送らず、全員を 1012 で閉じて外す", async () => {
    const store = newStore();
    const hub = new PrivateStreamHub(store, { assetKeys: "camel" });
    hub.start();
    const r = recorder();
    hub.addClient(r.client);
    store.replace(placed(store.state()));
    const before = r.sent.length;

    await store.reset(buildState());
    expect(r.closed).toEqual([{ code: RESET_CLOSE_CODE, reason: RESET_CLOSE_REASON }]);
    expect(r.sent).toHaveLength(before);
    expect(hub.clientCount()).toBe(0);

    // 外したので、以後の変化は届かない。
    store.replace(placed(store.state()));
    expect(r.sent).toHaveLength(before);
  });

  it("閉じ損ねた購読者も reset で外す", async () => {
    const store = newStore();
    const hub = new PrivateStreamHub(store, { assetKeys: "camel" });
    hub.start();
    hub.addClient({
      send: () => {},
      close: () => {
        throw new Error("already closed");
      },
    });
    await store.reset(buildState());
    expect(hub.clientCount()).toBe(0);
  });

  it("送れなかった購読者は 1011 で閉じて外し、他の購読者には送り続ける", () => {
    const warnings: string[] = [];
    const store = newStore();
    const hub = new PrivateStreamHub(store, {
      assetKeys: "camel",
      logger: { warn: (m) => warnings.push(m), info: () => {} },
    });
    hub.start();
    const closed: number[] = [];
    hub.addClient({
      send: () => {
        throw new Error("socket\nbroken");
      },
      close: (code) => closed.push(code),
    });
    const ok = recorder();
    hub.addClient(ok.client);

    store.replace(placed(store.state()));
    expect(closed).toEqual([1011]);
    expect(hub.clientCount()).toBe(1);
    expect(ok.sent.map((m) => m.message.method)).toEqual(["spot_order_new", "asset_update"]);
    // 理由は JSON で包んで 1 行に収める。外した後は 1 度しか警告しない。
    expect(warnings).toEqual(['private stream: send failed, closing: "socket\\nbroken"']);
  });

  it("送れず、閉じられず、警告まで投げても、状態の差し替えと他の購読者への配信は止まらない", () => {
    const store = newStore();
    const hub = new PrivateStreamHub(store, {
      assetKeys: "camel",
      logger: {
        warn: () => {
          throw new Error("EPIPE");
        },
        info: () => {},
      },
    });
    hub.start();
    hub.addClient({
      send: () => {
        throw "not an Error";
      },
      close: () => {
        throw new Error("already closed");
      },
    });
    const ok = recorder();
    hub.addClient(ok.client);
    const next = placed(store.state());
    store.replace(next);
    expect(store.state()).toBe(next);
    expect(ok.sent).toHaveLength(2);
    expect(hub.clientCount()).toBe(1);
  });

  it("外した購読者には送らない", () => {
    const store = newStore();
    const hub = new PrivateStreamHub(store, { assetKeys: "camel" });
    hub.start();
    const r = recorder();
    const remove = hub.addClient(r.client);
    remove();
    store.replace(placed(store.state()));
    expect(r.sent).toEqual([]);
  });

  it("start を 2 回呼んでも 1 通ずつで、stop の後は送らない", () => {
    const store = newStore();
    const hub = new PrivateStreamHub(store, { assetKeys: "camel" });
    hub.start();
    hub.start();
    const r = recorder();
    hub.addClient(r.client);
    store.replace(placed(store.state()));
    expect(r.sent.map((m) => m.message.method)).toEqual(["spot_order_new", "asset_update"]);

    hub.stop();
    store.replace(placed(store.state()));
    expect(r.sent).toHaveLength(2);
  });
});

/** 保留・再送（`hold()` / `heldMessages()` / `release()`）。 */
describe("PrivateStreamHub の保留・再送", () => {
  /** 保留した hub。`place()` は発注 1 回ぶんの差し替え（`spot_order_new` と `asset_update` の 2 通）。 */
  function held(opts: { holdLimit?: number; deliveryPolicy?: DeliveryPolicy } = {}) {
    const warnings: string[] = [];
    const store = newStore();
    const hub = new PrivateStreamHub(store, {
      assetKeys: "camel",
      logger: { warn: (m) => warnings.push(m), info: () => {} },
      ...opts,
    });
    hub.start();
    const place = () => {
      const prev = store.state();
      const next = placed(prev);
      store.replace(next);
      return stateChangeMessages(prev, next, { feeRate: 0, assetKeys: "camel" });
    };
    return { store, hub, place, warnings };
  }

  it("保留中は送らずに溜め、溜めた順に 1 から番号を振る", () => {
    const { hub, place } = held();
    const r = recorder();
    hub.addClient(r.client);
    expect(hub.hold()).toEqual({
      holding: true,
      held: 0,
      limit: DEFAULT_HOLD_LIMIT,
      overflowed: false,
      dropped: 0,
    });

    const first = place();
    const second = place();
    expect(r.sent).toEqual([]);
    expect(hub.heldMessages()).toEqual(
      [...first, ...second].map((frame, i) => ({ seq: i + 1, frame })),
    );
    expect(hub.holdStatus()).toMatchObject({ holding: true, held: 4 });
  });

  it("保留していなければ状況は空で、溜めたものも無い", () => {
    const { hub } = held({ holdLimit: 5 });
    expect(hub.holdStatus()).toEqual({
      holding: false,
      held: 0,
      limit: 5,
      overflowed: false,
      dropped: 0,
    });
    expect(hub.heldMessages()).toEqual([]);
  });

  it("購読者が 0 人でも保留中は溜め、release の時点で繋がっている購読者へ届ける", () => {
    const { hub, place } = held();
    hub.hold();
    const messages = place();
    expect(hub.holdStatus().held).toBe(messages.length);

    // 保留の後に繋いだ購読者にも、繋ぐ前の変化が届く（「接続した後の変化だけ」の例外）。
    const r = recorder();
    hub.addClient(r.client);
    const res = hub.release();
    expect(res).toEqual({
      success: true,
      data: { sent: messages.length, omitted: [], clients: 1 },
    });
    expect(r.sent).toEqual(messages);
  });

  it("hold を 2 回呼んでも溜めたものを捨てず、番号も振り直さない", () => {
    const { hub, place } = held();
    hub.hold();
    const first = place();
    expect(hub.hold()).toMatchObject({ holding: true, held: first.length });
    place();
    expect(hub.heldMessages().map((m) => m.seq)).toEqual([1, 2, 3, 4]);
  });

  it("order を省略した release は溜めた順に全員へ送り、以後は通常の配信に戻る", () => {
    const { hub, place } = held();
    const a = recorder();
    const b = recorder();
    hub.addClient(a.client);
    hub.addClient(b.client);
    hub.hold();
    const messages = place();

    expect(hub.release()).toEqual({
      success: true,
      data: { sent: 2, omitted: [], clients: 2 },
    });
    expect(a.sent).toEqual(messages);
    expect(b.sent).toEqual(messages);
    expect(hub.holdStatus().holding).toBe(false);
    expect(hub.heldMessages()).toEqual([]);

    const after = place();
    expect(a.sent).toEqual([...messages, ...after]);
  });

  it("order の番号の順に送る。同じ番号を 2 度書けば重複、書かなければ欠落", () => {
    const { hub, place } = held();
    const r = recorder();
    hub.addClient(r.client);
    hub.hold();
    const frames = [...place(), ...place()];

    const res = hub.release([4, 1, 1]);
    expect(res).toEqual({ success: true, data: { sent: 3, omitted: [2, 3], clients: 1 } });
    expect(r.sent).toEqual([frames[3], frames[0], frames[0]]);
  });

  it("空の order は何も送らずに溜めたものをすべて捨て、保留を解く", () => {
    const { hub, place } = held();
    const r = recorder();
    hub.addClient(r.client);
    hub.hold();
    place();
    expect(hub.release([])).toEqual({
      success: true,
      data: { sent: 0, omitted: [1, 2], clients: 1 },
    });
    expect(r.sent).toEqual([]);
    expect(hub.holdStatus().holding).toBe(false);
  });

  it("送るものがあるのに購読者が 0 人なら NO_CLIENTS で断り、保留も溜めたものも残す", () => {
    const { hub, place } = held();
    hub.hold();
    const frames = place();
    const before = hub.heldMessages();

    expect(hub.release()).toEqual({ success: false, error: "NO_CLIENTS" });
    expect(hub.release([2, 2])).toEqual({ success: false, error: "NO_CLIENTS" });
    expect(hub.heldMessages()).toEqual(before);
    expect(hub.holdStatus().holding).toBe(true);

    // 繋いでから送り直せば届く（利用側が止まっている間の変化を、繋ぎ直した後に届ける形）。
    const r = recorder();
    hub.addClient(r.client);
    expect(hub.release()).toEqual({
      success: true,
      data: { sent: 2, omitted: [], clients: 1 },
    });
    expect(r.sent).toEqual(frames);
  });

  it("送るものが 0 通なら購読者が 0 人でも断らない（空の order で溜めたものを捨てられる）", () => {
    const { hub, place } = held();
    hub.hold();
    place();
    expect(hub.release([])).toEqual({
      success: true,
      data: { sent: 0, omitted: [1, 2], clients: 0 },
    });
    expect(hub.holdStatus()).toMatchObject({ holding: false, held: 0 });

    // 何も溜まっていない保留を order の省略で解くのも、送るものが 0 通なので通る。
    hub.hold();
    expect(hub.release()).toEqual({ success: true, data: { sent: 0, omitted: [], clients: 0 } });
  });

  it("order の検査は購読者の有無より先に行う", () => {
    const { hub, place } = held();
    hub.hold();
    place();
    expect(hub.release([3])).toEqual({ success: false, error: "INVALID_ORDER" });
  });

  it("保留していなければ release は NOT_HOLDING で断る", () => {
    const { hub } = held();
    expect(hub.release()).toEqual({ success: false, error: "NOT_HOLDING" });
  });

  it.each([
    { name: "0 番", order: [0] },
    { name: "溜めた数を超える番号", order: [3] },
    { name: "負の番号", order: [-1] },
    { name: "整数でない番号", order: [1.5] },
    { name: "NaN", order: [Number.NaN] },
    { name: "上限より長い並び", order: [1, 1, 1, 1] },
  ])("$name を含む order は INVALID_ORDER で断り、保留も溜めたものも残す", ({ order }) => {
    const { hub, place } = held({ holdLimit: 3 });
    const r = recorder();
    hub.addClient(r.client);
    hub.hold();
    const frames = place();
    const before = hub.heldMessages();

    expect(hub.release(order)).toEqual({ success: false, error: "INVALID_ORDER" });
    expect(r.sent).toEqual([]);
    expect(hub.heldMessages()).toEqual(before);
    expect(hub.release([1, 2])).toMatchObject({ success: true });
    expect(r.sent).toEqual(frames);
  });

  it("配信方針を通した後の列を溜める", () => {
    const policy: DeliveryPolicy = (ms) => [...ms].reverse();
    const { hub, place } = held({ deliveryPolicy: policy });
    hub.hold();
    place();
    expect(hub.heldMessages().map((m) => m.frame.message.method)).toEqual([
      "asset_update",
      "spot_order_new",
    ]);
  });

  it("メッセージを作らない変化（時計だけ）は溜めず、溢れの判定にも数えない", () => {
    const { store, hub } = held({ holdLimit: 1 });
    hub.hold();
    store.replace({ ...store.state(), lastTickAt: "2026-01-02T00:00:00.000Z" });
    expect(hub.holdStatus()).toMatchObject({ held: 0, overflowed: false, dropped: 0 });
  });

  it("入りきらない変化は丸ごと溜めず、印と落とした通数を残し、以後の変化もすべて落とす", () => {
    const { store, hub, place, warnings } = held({ holdLimit: 3 });
    const r = recorder();
    hub.addClient(r.client);
    hub.hold();
    const first = place(); // 2 通。上限 3 に収まる
    place(); // 2 通。合わせて 4 通で入りきらない
    expect(hub.holdStatus()).toEqual({
      holding: true,
      held: 2,
      limit: 3,
      overflowed: true,
      dropped: 2,
    });
    expect(hub.heldMessages().map((m) => m.frame)).toEqual(first);

    // 1 通だけの変化なら上限に収まるが、溢れた後は溜めない（途中だけ抜けた列を作らない）。
    store.replace({ ...store.state(), balances: { ...store.state().balances, jpy: 1 } });
    expect(hub.holdStatus()).toMatchObject({ held: 2, dropped: 3 });
    expect(r.sent).toEqual([]);
    // 警告は溢れた最初の 1 回だけ。
    expect(warnings).toEqual([
      "private stream: hold buffer is full (limit 3); later messages are dropped and release is refused until POST /_control/reset",
    ]);
  });

  it("溢れた後の release は OVERFLOWED で断り、保留も溜めたものも残す", () => {
    const { hub, place } = held({ holdLimit: 2 });
    hub.hold();
    place();
    place();
    expect(hub.release()).toEqual({ success: false, error: "OVERFLOWED" });
    expect(hub.release([1])).toEqual({ success: false, error: "OVERFLOWED" });
    expect(hub.holdStatus()).toMatchObject({ holding: true, held: 2, overflowed: true });
  });

  it("溢れを知らせる警告が投げても、印と落とした通数は残る", () => {
    const store = newStore();
    const hub = new PrivateStreamHub(store, {
      assetKeys: "camel",
      holdLimit: 1,
      logger: {
        warn: () => {
          throw new Error("EPIPE");
        },
        info: () => {},
      },
    });
    hub.start();
    hub.hold();
    const next = placed(store.state());
    store.replace(next);
    expect(store.state()).toBe(next);
    expect(hub.holdStatus()).toMatchObject({ held: 0, overflowed: true, dropped: 2 });
  });

  it("reset は溜めたものを捨てて保留を解き、購読者を閉じる", async () => {
    const { store, hub, place } = held({ holdLimit: 2 });
    const r = recorder();
    hub.addClient(r.client);
    hub.hold();
    place();
    place(); // 溢れさせても reset で抜け出せる
    expect(hub.holdStatus().overflowed).toBe(true);

    await store.reset(buildState());
    expect(r.closed).toEqual([{ code: RESET_CLOSE_CODE, reason: RESET_CLOSE_REASON }]);
    expect(r.sent).toEqual([]);
    expect(hub.holdStatus()).toEqual({
      holding: false,
      held: 0,
      limit: 2,
      overflowed: false,
      dropped: 0,
    });

    // 繋ぎ直した購読者には、以後の変化が通常どおり届く。
    const again = recorder();
    hub.addClient(again.client);
    const after = place();
    expect(again.sent).toEqual(after);
  });

  it("購読者が 0 人でも reset は保留を解く", async () => {
    const { store, hub, place } = held();
    hub.hold();
    place();
    await store.reset(buildState());
    expect(hub.holdStatus().holding).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN])("holdLimit に %s は渡せない", (holdLimit) => {
    expect(() => new PrivateStreamHub(newStore(), { assetKeys: "camel", holdLimit })).toThrow(
      RangeError,
    );
  });
});

/** 切断（`disconnectAll()`）と、新しい接続を受け付けない状態（`refuse()` / `accept()`）。 */
describe("PrivateStreamHub の切断", () => {
  function started(deliveryPolicy?: DeliveryPolicy) {
    const store = newStore();
    const hub = new PrivateStreamHub(store, { assetKeys: "camel", deliveryPolicy });
    hub.start();
    const place = () => {
      const prev = store.state();
      const next = placed(prev);
      store.replace(next);
      return stateChangeMessages(prev, next, { feeRate: 0, assetKeys: "camel" });
    };
    return { store, hub, place };
  }

  it("disconnectAll は全員を 1001 で閉じて外し、閉じた数を返す。以後の変化は届かない", () => {
    const { hub, place } = started();
    const a = recorder();
    const b = recorder();
    hub.addClient(a.client);
    hub.addClient(b.client);

    expect(hub.disconnectAll()).toBe(2);
    const closed = { code: DISCONNECT_CLOSE_CODE, reason: DISCONNECT_CLOSE_REASON };
    expect(closed).toEqual({ code: 1001, reason: "disconnected by /_control/stream/disconnect" });
    expect(a.closed).toEqual([closed]);
    expect(b.closed).toEqual([closed]);
    expect(hub.clientCount()).toBe(0);

    place();
    expect(a.sent).toEqual([]);
    expect(b.sent).toEqual([]);
  });

  it("購読者が 0 人なら 0 を返し、2 回目も投げない", () => {
    const { hub } = started();
    expect(hub.disconnectAll()).toBe(0);
    hub.addClient(recorder().client);
    expect(hub.disconnectAll()).toBe(1);
    expect(hub.disconnectAll()).toBe(0);
  });

  it("閉じ損ねた購読者も外し、閉じた数に入れる", () => {
    const { hub } = started();
    hub.addClient({
      send: () => {},
      close: () => {
        throw new Error("already closed");
      },
    });
    const ok = recorder();
    hub.addClient(ok.client);
    expect(hub.disconnectAll()).toBe(2);
    expect(hub.clientCount()).toBe(0);
    expect(ok.closed).toHaveLength(1);
  });

  it("状態にも、受け付けるかどうかにも触れない", () => {
    const { store, hub, place } = started();
    hub.addClient(recorder().client);
    place();
    const before = store.state();
    hub.refuse();
    hub.disconnectAll();
    expect(store.state()).toBe(before);
    expect(hub.isAccepting()).toBe(false);
    hub.accept();
    hub.disconnectAll();
    expect(hub.isAccepting()).toBe(true);
  });

  it("保留していなければ、切っている間の変化はメッセージも作らず、繋ぎ直しても届かない", () => {
    const policy = vi.fn<DeliveryPolicy>((ms) => ms);
    const { hub, place } = started(policy);
    hub.addClient(recorder().client);
    hub.disconnectAll();
    place();
    expect(policy).not.toHaveBeenCalled();

    const again = recorder();
    hub.addClient(again.client);
    expect(again.sent).toEqual([]);
    const after = place();
    expect(again.sent).toEqual(after);
  });

  it("保留も溜めたものも残すので、切る前に hold して繋ぎ直してから release すれば、切っていた間の変化が届く", () => {
    const { hub, place } = started();
    const r = recorder();
    hub.addClient(r.client);
    hub.hold();
    const before = place(); // 切る前の変化（保留中なので溜まる）
    expect(hub.disconnectAll()).toBe(1);
    expect(hub.holdStatus()).toMatchObject({ holding: true, held: before.length });

    const during = place(); // 切っている間の変化。購読者は 0 人だが溜まる
    expect(hub.heldMessages().map((m) => m.frame)).toEqual([...before, ...during]);
    expect(hub.release()).toEqual({ success: false, error: "NO_CLIENTS" });

    const again = recorder();
    hub.addClient(again.client);
    expect(hub.release()).toEqual({
      success: true,
      data: { sent: before.length + during.length, omitted: [], clients: 1 },
    });
    expect(again.sent).toEqual([...before, ...during]);
    // 切った接続には何も届かない。
    expect(r.sent).toEqual([]);
  });

  it("refuse と accept は何度呼んでも同じ結果で、今の接続は閉じない", () => {
    const { hub, place } = started();
    expect(hub.isAccepting()).toBe(true);
    const r = recorder();
    hub.addClient(r.client);

    hub.refuse();
    hub.refuse();
    expect(hub.isAccepting()).toBe(false);
    expect(r.closed).toEqual([]);
    // 受け付けないのは新しい接続だけで、今の接続には送り続ける。
    const messages = place();
    expect(r.sent).toEqual(messages);

    hub.accept();
    hub.accept();
    expect(hub.isAccepting()).toBe(true);
  });

  it("reset は受け付ける状態に戻す", async () => {
    const { store, hub } = started();
    hub.refuse();
    await store.reset(buildState());
    expect(hub.isAccepting()).toBe(true);
  });
});
