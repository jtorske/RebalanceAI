import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE_URL } from "../lib/constants";

export type ApiHealthStatus = "checking" | "ready" | "warming" | "error";

type HealthResult = {
  status: ApiHealthStatus;
  elapsedMs: number;
  retryNow: () => void;
  isHostedApi: boolean;
  attempt: number;
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

async function fetchOk(url: string, parentSignal: AbortSignal): Promise<boolean> {
  const ctl = new AbortController();
  const tid = window.setTimeout(() => ctl.abort(), HEALTH_TIMEOUT_MS);
  const abortOnParent = () => ctl.abort();
  parentSignal.addEventListener("abort", abortOnParent, { once: true });
  try {
    const res = await fetch(url, { cache: "no-store", signal: ctl.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(tid);
    parentSignal.removeEventListener("abort", abortOnParent);
  }
}

export function useApiHealth(): HealthResult {
  const isHostedApi = useMemo(() => isHostedApiUrl(API_BASE_URL), []);
  const [status, setStatus] = useState<ApiHealthStatus>("checking");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const startedAtRef = useRef<number>(0);
  // Prevents re-running the check once the backend is confirmed ready.
  // Cleared on manual retry so retryNow() still works.
  const isReadyRef = useRef(false);

  const retryNow = useCallback(() => {
    isReadyRef.current = false;
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    setStatus("checking");
    setAttempt((v) => v + 1);
  }, []);

  useEffect(() => {
    if (isReadyRef.current) return;

    const controller = new AbortController();
    let retryId: number | undefined;
    if (startedAtRef.current === 0) startedAtRef.current = Date.now();

    const scheduleRetry = (elapsed: number) => {
      if (elapsed < ERROR_AFTER_MS) {
        console.log("[API] retrying status check");
        retryId = window.setTimeout(() => setAttempt((v) => v + 1), RETRY_INTERVAL_MS);
      }
    };

    const run = async () => {
      // Phase 1: liveness — server must respond at all
      const alive = await fetchOk(`${API_BASE_URL}/api/status`, controller.signal);
      if (controller.signal.aborted) return;

      if (!alive) {
        if (!isHostedApi) {
          isReadyRef.current = true;
          setStatus("ready");
          return;
        }
        const elapsed = Date.now() - startedAtRef.current;
        setElapsedMs(elapsed);
        if (elapsed < ERROR_AFTER_MS) console.log("[API] backend waking up");
        setStatus(elapsed >= ERROR_AFTER_MS ? "error" : "checking");
        scheduleRetry(elapsed);
        return;
      }

      // Phase 2: readiness — server is up and accepting work
      setStatus("warming");
      const ready = await fetchOk(`${API_BASE_URL}/api/ready`, controller.signal);
      if (controller.signal.aborted) return;

      if (ready || !isHostedApi) {
        isReadyRef.current = true;
        console.log("[API] backend ready");
        setStatus("ready");
        return;
      }

      const elapsed = Date.now() - startedAtRef.current;
      setElapsedMs(elapsed);
      setStatus(elapsed >= ERROR_AFTER_MS ? "error" : "warming");
      scheduleRetry(elapsed);
    };

    const elapsedId = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAtRef.current);
    }, 1000);

    void run();

    return () => {
      controller.abort();
      if (retryId) window.clearTimeout(retryId);
      window.clearInterval(elapsedId);
    };
  }, [attempt, isHostedApi]);

  return { status, elapsedMs, retryNow, isHostedApi, attempt };
}
