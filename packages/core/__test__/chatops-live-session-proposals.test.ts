import { describe, expect, it } from "vitest";
import { LiveSessionProposalStore } from "../src/chatops/live-session-proposals.js";

const proposal = { projectPath: "/p", instruction: "debug prod" };

describe("LiveSessionProposalStore", () => {
  it("claim is one-shot", () => {
    const store = new LiveSessionProposalStore();
    const p = store.add({ proposal, conversationId: "c1", proposedBy: "sam" });
    expect(store.claim(p.id)?.proposal.instruction).toBe("debug prod");
    expect(store.claim(p.id)).toBeUndefined();
  });

  it("expired proposals cannot be claimed", () => {
    let now = 0;
    const store = new LiveSessionProposalStore(() => now);
    const p = store.add({ proposal, conversationId: "c1", proposedBy: "sam" });
    now = 11 * 60_000;
    expect(store.claim(p.id)).toBeUndefined();
  });

  it("setCardActivityId attaches the card id", () => {
    const store = new LiveSessionProposalStore();
    const p = store.add({ proposal, conversationId: "c1", proposedBy: "sam" });
    store.setCardActivityId(p.id, "act-9");
    expect(store.claim(p.id)?.cardActivityId).toBe("act-9");
  });
});
