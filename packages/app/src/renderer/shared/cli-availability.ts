import { useEffect, useState } from "preact/hooks";
import type { AvailableModel, CliName } from "@bean/core";

export interface CliAvailability {
  clis: CliName[];
  models: AvailableModel[];
}

interface CliAvailabilityApi {
  availableClis: () => Promise<CliName[]>;
  availableModels: () => Promise<AvailableModel[]>;
  onCliAvailabilityChanged: (cb: () => void) => void;
}

/** Fetch immediately and again after a successful Settings save. The main process remains
 * authoritative; the event is only invalidation, so a renderer never trusts event payloads. */
export function watchCliAvailability(
  api: CliAvailabilityApi,
  onChange: (availability: CliAvailability) => void,
): void {
  const refresh = (): void => {
    void Promise.all([api.availableClis(), api.availableModels()])
      .then(([clis, models]) => onChange({ clis, models }));
  };
  refresh();
  api.onCliAvailabilityChanged(refresh);
}

export function useCliAvailability(): CliAvailability {
  const [availability, setAvailability] = useState<CliAvailability>({ clis: [], models: [] });
  useEffect(() => watchCliAvailability(window.bean, setAvailability), []);
  return availability;
}
