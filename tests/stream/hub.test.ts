import { describe, expect, it, vi } from "vitest";
import type { PaperState } from "../../src/engine/state.ts";
import { placeOrder } from "../../src/engine/transitions.ts";
import { SessionStore } from "../../src/store/session.ts";
import { type PrivateStreamMessage, stateChangeMessages } from "../../src/stream/events.ts";
import {
  type DeliveryPolicy,
  PrivateStreamHub,
  RESET_CLOSE_CODE,
  RESET_CLOSE_REASON,
  type StreamClient,
} from "../../src/stream/hub.ts";
import { buildState } from "../engine/helpers.ts";
import { stubFetchCandles } from "../routes/helpers.ts";

const T = "2026-01-01T00:00:00.000Z";

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
