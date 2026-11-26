import type { AvailableModel, CliName } from "@bean/core";
import { effortLabel, modelEfforts, shortEffortLabel } from "@bean/core/models";

/** Shared Model + Effort popover body used by the chat composer pill, DelegateCard, ProposalCard,
 * and Sprouts StepsEditor. Model rows sit on top; when the active model offers reasoning efforts
 * on the active CLI, a compact segmented effort bar sits right below so both can be set in one open. */
export function ModelEffortMenu({
  models,
  cli,
  selectedModel,
  selectedEffort,
  onPickModel,
  onPickEffort,
  close,
  disabled = false,
  headerHint,
  topOption,
  allowUnsetEffort = false,
  unsetEffortLabel = "Default",
  lastUsedModel,
  lastUsedBadge,
  showCliCaptions = false,
  enabledClis,
}: {
  models: readonly AvailableModel[];
  /** Active CLI when known; used to look up effort options for the selected model. */
  cli?: CliName;
  selectedModel?: string;
  selectedEffort?: string;
  onPickModel: (id: string | undefined) => void;
  onPickEffort: (effort: string | undefined) => void;
  close: () => void;
  disabled?: boolean;
  headerHint?: string;
  /** Optional "auto" row at the top (e.g. Sprouts' "Bean picks the model"). */
  topOption?: { label: string; selected: boolean };
  /** Show a "Default" button in the effort bar (lets Sprouts leave effort unpinned). */
  allowUnsetEffort?: boolean;
  unsetEffortLabel?: string;
  lastUsedModel?: string;
  lastUsedBadge?: string;
  showCliCaptions?: boolean;
  enabledClis?: readonly CliName[];
}) {
  const effectiveCli = cli ?? models.find((m) => m.id === selectedModel)?.availableOn[0];
  const effortInfo = effectiveCli && selectedModel ? modelEfforts(models, effectiveCli, selectedModel) : undefined;
  const efforts = effortInfo?.efforts ?? [];

  const pickModel = (m: AvailableModel): void => {
    if (disabled) return;
    const same = m.id === selectedModel;
    const targetCli = cli ?? m.availableOn.find((c) => !enabledClis || enabledClis.includes(c)) ?? m.availableOn[0];
    const nextEfforts = targetCli ? m.effortsByCli?.[targetCli]?.efforts : undefined;
    onPickModel(m.id);
    // Keep the menu open when switching to a model that has effort choices so model + effort
    // can be picked in a single open; close immediately when re-picking or when there are no efforts.
    if (same || !nextEfforts?.length) close();
  };

  return (
    <div class="bean-chip-menu-list">
      {headerHint ? <div class="bean-chip-menu-hint">{headerHint}</div> : null}
      {topOption ? (
        <>
          <button
            type="button"
            disabled={disabled}
            class={`bean-chip-menu-row${topOption.selected ? " bean-chip-menu-row--on" : ""}`}
            onClick={() => { if (!disabled) { onPickModel(undefined); close(); } }}
          >
            {topOption.selected ? "✓ " : ""}{topOption.label}
          </button>
          <div class="bean-chip-menu-divider" />
        </>
      ) : null}
      {models.map((m) => {
        const available = !enabledClis || m.availableOn.some((c) => enabledClis.includes(c));
        const on = selectedModel === m.id;
        return (
          <button
            key={m.id}
            type="button"
            disabled={disabled || !available}
            title={m.id}
            class={`bean-chip-menu-row bean-chip-menu-row--model${on ? " bean-chip-menu-row--on" : ""}${available ? "" : " bean-chip-menu-row--dimmed"}`}
            onClick={() => { if (available) pickModel(m); }}
          >
            <span class="bean-chip-menu-row-title">
              {on ? "✓ " : ""}{m.label}
              {lastUsedBadge && m.id === lastUsedModel ? <em class="bean-chip-menu-badge">{lastUsedBadge}</em> : null}
            </span>
            {showCliCaptions ? (
              <span class="bean-chip-menu-caption">
                {m.availableOn.join("  /  ") || "no CLI support"}
              </span>
            ) : null}
          </button>
        );
      })}
      {efforts.length > 0 ? (
        <>
          <div class="bean-chip-menu-divider" />
          <div class="bean-effort-section">
            <div class="bean-chip-menu-hint">Effort</div>
            <div class="bean-effort-seg" role="group" aria-label="Reasoning effort">
              {allowUnsetEffort ? (
                <button
                  type="button"
                  disabled={disabled}
                  class={`bean-effort-btn${selectedEffort === undefined ? " bean-effort-btn--on" : ""}`}
                  aria-pressed={selectedEffort === undefined}
                  onClick={() => { if (!disabled) { onPickEffort(undefined); close(); } }}
                >
                  {unsetEffortLabel}
                </button>
              ) : null}
              {efforts.map((level) => {
                const on = selectedEffort === level;
                return (
                  <button
                    key={level}
                    type="button"
                    disabled={disabled}
                    class={`bean-effort-btn${on ? " bean-effort-btn--on" : ""}`}
                    aria-pressed={on}
                    title={effortLabel(level)}
                    onClick={() => { if (!disabled) { onPickEffort(level); close(); } }}
                  >
                    {shortEffortLabel(level)}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
