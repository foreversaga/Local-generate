import { useSyncExternalStore } from "react";
import { activeJobCount } from "../../lib/job-adapter.mjs";
import { fetchUnifiedJobs, type JobSourceError, type UnifiedJob } from "./job-client";

export type UnifiedJobsFeedSnapshot = {
    jobs: UnifiedJob[];
    errors: JobSourceError[];
    loading: boolean;
    error: string;
    updatedAt: number;
};

const listeners = new Set<() => void>();
const INITIAL_SNAPSHOT: UnifiedJobsFeedSnapshot = Object.freeze({
    jobs: [],
    errors: [],
    loading: true,
    error: "",
    updatedAt: 0,
});

let snapshot: UnifiedJobsFeedSnapshot = INITIAL_SNAPSHOT;
let timer = 0;
let requestInFlight: Promise<void> | null = null;
let running = false;

export function useUnifiedJobsFeed() {
    return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function getUnifiedJobsFeedSnapshot() {
    return snapshot;
}

export function refreshUnifiedJobsFeed() {
    return refresh();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    if (!running) start();
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stop();
    };
}

function getSnapshot() {
    return snapshot;
}

function getServerSnapshot() {
    return INITIAL_SNAPSHOT;
}

function start() {
    running = true;
    void refresh();
}

function stop() {
    running = false;
    if (timer) window.clearTimeout(timer);
    timer = 0;
}

async function refresh() {
    if (requestInFlight) return requestInFlight;
    requestInFlight = runRefresh().finally(() => {
        requestInFlight = null;
    });
    return requestInFlight;
}

async function runRefresh() {
    let delay = 15_000;
    try {
        if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
        const next = await fetchUnifiedJobs({ summary: true, includeOutputAvailability: false });
        delay = activeJobCount(next.jobs) > 0 ? 5_000 : 15_000;
        publish({
            jobs: next.jobs,
            errors: next.errors,
            loading: false,
            error: "",
            updatedAt: Date.now(),
        });
    } catch (reason) {
        publish({
            ...snapshot,
            loading: false,
            error: reason instanceof Error ? reason.message : "Unable to load jobs.",
        });
    } finally {
        if (running) {
            if (timer) window.clearTimeout(timer);
            timer = window.setTimeout(() => void refresh(), delay);
        }
    }
}

function publish(next: UnifiedJobsFeedSnapshot) {
    snapshot = next;
    for (const listener of listeners) listener();
}
