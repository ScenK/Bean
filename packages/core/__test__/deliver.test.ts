import { expect, test } from "vitest";
import { deliver, type Transport, type DeliverMessage } from "../src/deliver.js";

function transport(name: string, available: boolean, sink: DeliverMessage[], throws = false): Transport {
  return {
    name,
    available: () => available,
    send: (msg) => {
      if (throws) throw new Error(`${name} boom`);
      sink.push(msg);
    },
  };
}

test("fans to available transports and skips unavailable ones", async () => {
  const a: DeliverMessage[] = [];
  const b: DeliverMessage[] = [];
  const msg: DeliverMessage = { body: "hi" };
  const outcomes = await deliver(msg, [transport("a", true, a), transport("b", false, b)]);
  expect(a).toEqual([msg]);
  expect(b).toEqual([]);
  expect(outcomes).toEqual([{ name: "a", ok: true }]);
});

test("one throwing transport does not block the others", async () => {
  const good: DeliverMessage[] = [];
  const msg: DeliverMessage = { body: "hi" };
  const outcomes = await deliver(msg, [
    transport("bad", true, [], true),
    transport("good", true, good),
  ]);
  expect(good).toEqual([msg]);
  expect(outcomes[0]!.name).toBe("bad");
  expect(outcomes[0]!.ok).toBe(false);
  expect(outcomes[0]!.error).toBeInstanceOf(Error);
  expect(outcomes[1]).toEqual({ name: "good", ok: true });
});

test("empty / all-unavailable list resolves to no outcomes without throwing", async () => {
  expect(await deliver({ body: "x" }, [])).toEqual([]);
  expect(await deliver({ body: "x" }, [transport("off", false, [])])).toEqual([]);
});
