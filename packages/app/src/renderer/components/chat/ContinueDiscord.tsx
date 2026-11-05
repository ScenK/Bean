import { useState } from "preact/hooks";
import { AGENT_NAMES } from "../../shared/AgentAvatar.js";
import type { LiveCli } from "@bean/core";
import type { DestinationView } from "../../../destinations.js";

/** The last channel picked — a renderer-only view pref (convention-renderer-view-prefs-in-localstorage). */
export const CONTINUE_CHANNEL_KEY = "bean.continueDiscord.channel";
const TITLE_MAX = 100;

/** The Discord channels a thread can open under: labelled `channel` rows only. */
export const continueChannels = (rows: readonly DestinationView[]): DestinationView[] =>
  rows.filter((r) => r.surface === "discord" && r.kind === "channel" && r.label);

/** Continue in Discord (#697): the chat header's button and its picker. `disabled` = why it can't
 * run now (shown as the button's tooltip). `agent` = this chat's open agent session moves too.
 * `onContinue` resolves to an error to show, or undefined once the chat moved. */
export function ContinueDiscord({ disabled, title, agent, count, onContinue }: {
  disabled?: string;
  title: string;
  agent?: LiveCli;
  /** Recent messages the plain chat carries over (agent mode carries the session instead). */
  count: number;
  onContinue: (channelId: string, title: string) => Promise<string | undefined>;
}) {
  const [open, setOpen] = useState(false);
  const [channels, setChannels] = useState<DestinationView[] | undefined>(undefined);
  const [pick, setPick] = useState("");
  const [name, setName] = useState(title);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const show = (): void => {
    setOpen(true);
    setName(title);
    setError(undefined);
    setChannels(undefined);
    window.bean.destinationsList().then((rows) => {
      const list = continueChannels(rows ?? []);
      setChannels(list);
      const last = localStorage.getItem(CONTINUE_CHANNEL_KEY);
      setPick(list.some((c) => c.conversationId === last) ? last! : list[0]?.conversationId ?? "");
    }, () => setChannels([]));
  };
  const submit = async (): Promise<void> => {
    if (sending || !pick || !name.trim()) return;
    setSending(true);
    setError(undefined);
    localStorage.setItem(CONTINUE_CHANNEL_KEY, pick);
    const err = await onContinue(pick, name.trim());
    setSending(false);
    if (err) setError(err);
    else setOpen(false);
  };

  return (
    <>
      <button
        type="button"
        class="bean-chat-continue"
        disabled={disabled !== undefined}
        title={disabled ?? "Continue this chat in a Discord thread"}
        onClick={show}
      >Continue in Discord</button>
      {open ? (
        <div class="bean-memory-review">
          <div class="bean-memory-review-card bean-continue-card" role="dialog" aria-label="Continue in Discord">
            <div class="bean-memory-review-title">Continue in Discord</div>
            {channels === undefined ? (
              <div class="bean-offer-ask">Loading channels…</div>
            ) : channels.length === 0 ? (
              <div class="bean-offer-ask" role="note">
                No Discord channels yet — Bean lists the channels its Discord bot can post in once it has seen them.
              </div>
            ) : (
              <>
                <label class="bean-send-pick">
                  <span class="bean-offer-ask">Channel</span>
                  <select
                    class="bean-send-select"
                    aria-label="Channel"
                    value={pick}
                    disabled={sending}
                    onChange={(e) => setPick((e.currentTarget as HTMLSelectElement).value)}
                  >
                    {channels.map((c) => <option key={c.conversationId} value={c.conversationId}>{c.label}</option>)}
                  </select>
                </label>
                <label class="bean-send-pick">
                  <span class="bean-offer-ask">Thread title</span>
                  <input
                    class="bean-input"
                    aria-label="Thread title"
                    maxLength={TITLE_MAX}
                    value={name}
                    disabled={sending}
                    onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
                  />
                </label>
                <div class="bean-offer-ask">
                  {agent
                    ? `Your ${AGENT_NAMES[agent]} session moves to the thread and ends here.`
                    : `The last ${count} message${count === 1 ? "" : "s"} go along as context.`}
                  {" "}This chat becomes read-only.
                </div>
                <div class="bean-offer-ask" role="note">Bean opens a public thread — anyone in the channel can read it.</div>
              </>
            )}
            {error ? <div class="bean-status bean-status--error">{error}</div> : null}
            <div class="bean-card-actions">
              <button
                type="button"
                class="bean-btn"
                disabled={sending || !pick || !name.trim() || !channels?.length}
                onClick={() => void submit()}
              >{sending ? "Continuing…" : "Continue in Discord"}</button>
              <button type="button" class="bean-btn bean-btn--ghost" disabled={sending} onClick={() => setOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
