import { useRef } from "preact/hooks";
import { PanelHeader } from "../../shared/Panel.js";

export function CommandBarPanel({
  droppedUrl,
  busy,
  onSend,
}: {
  droppedUrl?: string;
  busy: boolean;
  onSend: (text: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = (): void => {
    const el = inputRef.current;
    if (!el) return;
    const text = el.value;
    el.value = "";
    onSend(text);
  };

  return (
    <div class="bean-panel">
      <PanelHeader title="Command Bar" />
      <div class="bean-cmd">
        {droppedUrl ? <span class="bean-cmd-chip">🔗 {droppedUrl}</span> : null}
        <div class="bean-chat-input" style="border-top:none;padding:0">
          <input
            ref={inputRef}
            class="bean-input"
            type="text"
            placeholder="Tell Bean what to do…"
            disabled={busy}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          />
          <button type="button" class="bean-send" disabled={busy} onClick={submit}>⏎</button>
        </div>
      </div>
    </div>
  );
}
