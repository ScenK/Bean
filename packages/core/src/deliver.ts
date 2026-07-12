export interface DeliverMessage {
  body: string;
  title?: string;
  meta?: Record<string, unknown>;
}

export interface Transport {
  name: string;
  available(): boolean;
  send(msg: DeliverMessage): void | Promise<void>;
}

export interface DeliverOutcome {
  name: string;
  ok: boolean;
  error?: unknown;
}

// Fans a message to every available transport, isolating failures so one dead
// channel never blocks the others. Returns one outcome per available transport,
// in input order; unavailable transports are skipped entirely.
export async function deliver(msg: DeliverMessage, transports: Transport[]): Promise<DeliverOutcome[]> {
  const active = transports.filter((t) => t.available());
  const results = await Promise.allSettled(active.map(async (t) => t.send(msg)));
  return results.map((r, i) =>
    r.status === "fulfilled"
      ? { name: active[i]!.name, ok: true }
      : { name: active[i]!.name, ok: false, error: r.reason },
  );
}
