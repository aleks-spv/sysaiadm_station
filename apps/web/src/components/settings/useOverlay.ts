import { useCallback, useEffect, useState } from "react";
import { api, type OpencodeOverlay } from "@/api";
import { errorText } from "@/lib/utils";

// The opencode overlay is one document; agents, providers and the raw editor all save through it.
export function useOverlay() {
  const [overlay, setOverlay] = useState<OpencodeOverlay | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .opencodeConfig()
      .then((r) => {
        setOverlay(r.overlay);
        setError(null);
      })
      .catch((err: unknown) => setError(errorText(err)));
  }, []);

  useEffect(load, [load]);

  // Rebuilds from the latest server copy so two sections cannot overwrite each other's edits.
  const update = useCallback(async (change: (current: OpencodeOverlay) => OpencodeOverlay) => {
    const fresh = (await api.opencodeConfig()).overlay;
    const saved = (await api.saveOpencodeConfig(change(structuredClone(fresh)))).overlay;
    setOverlay(saved);
    return saved;
  }, []);

  return { overlay, error, update, reload: load };
}
