import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE_URL } from "../lib/constants";

export type ApiHealthStatus = "checking" | "ready" | "warming" | "error";

type HealthResult = {
  status: ApiHealthStatus;
  elapsedMs: number;
  retryNow: () => void;
  isHostedApi: boolean;
};

const HEALTH_TIMEOUT_MS = 3500;
const RETRY_INTERVAL_MS = 5000;
const ERROR_AFTER_MS = 65000;

const isHostedApiUrl = (url: string) => {
  try {
    const host = new URL(url).hostname;
    return host !== "localhost" && host !== "127.0.0.1";
  } catch {
    return true;
  }
};

async function checkHealth(signal: AbortSignal): Promise<boolean> {
  const timeoutController = new AbortController();
  const timeoutId = window.setTimeout(
    () => timeoutController.abort(),
    HEALTH_TIMEOUT_MS,
  );

  const abortOnParent = () => timeoutController.abort();
  signal.addEventListener("abort", abortOnParent, { once: true });

  try {
    const response = await fetch(`${API_BASE_URL}/health`, {
      cache: "no-store",
      signal: timeoutController.signal,
    });
    return response.ok;
  } finally {
    window.clearTimeout(timeoutId);
    signal.removeEventListener("abort", abortOnParent);
  }
}

export function useApiHealth(): HealthResult {
  const isHostedApi = useMemo(() => isHostedApiUrl(API_BASE_URL), []);
  const [status, setStatus] = useState<ApiHealthStatus>("checking");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const startedAtRef = useRef<number>(0);

  const retryNow = useCallback(() => {
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    setStatus("checking");
    setAttempt((value) => value + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let retryId: number | undefined;
    if (startedAtRef.current === 0) {
      startedAtRef.current = Date.now();
    }

    const run = async () => {
      const ok = await checkHealth(controller.signal).catch(() => false);
      if (controller.signal.aborted) return;

      if (ok) {
        setStatus("ready");
        return;
      }

      if (!isHostedApi) {
        setStatus("ready");
        return;
      }

      const elapsed = Date.now() - startedAtRef.current;
      setElapsedMs(elapsed);
      setStatus(elapsed >= ERROR_AFTER_MS ? "error" : "warming");

      if (elapsed < ERROR_AFTER_MS) {
        retryId = window.setTimeout(() => {
          setAttempt((value) => value + 1);
        }, RETRY_INTERVAL_MS);
      }
    };

    const elapsedId = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 1000);

    void run();

    return () => {
      controller.abort();
      if (retryId) window.clearTimeout(retryId);
      if (elapsedId) window.clearInterval(elapsedId);
    };
  }, [attempt, isHostedApi]);

  return { status, elapsedMs, retryNow, isHostedApi };
}
