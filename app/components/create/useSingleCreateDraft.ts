"use client";

import { useEffect, useRef, useState } from "react";
import {
  parseSingleCreateDraft,
  SINGLE_CREATE_DRAFT_STORAGE_KEY,
} from "../../lib/single-create-draft.mjs";

export type SingleCreateDraftInput = {
  mode: string;
  prompt: string;
  negativePrompt: string;
  modelProfile: string;
  width: number | "";
  height: number | "";
  duration: number;
  steps: number | "";
  seed: number | "";
  renderCount: number | "";
  outputName: string;
  characterLoraName: string;
  characterLoraStrength: number | "";
  referenceImageKey: string | null;
  referenceImageKeys: string[];
  lastFrameImageKey: string | null;
  sourceVideoKey: string | null;
};

export type SingleCreateDraft = SingleCreateDraftInput & { version: 1 };
export type SingleCreateDraftStatus = "loading" | "idle" | "saving" | "saved" | "error";

type UseSingleCreateDraftOptions = {
  ready: boolean;
  value: SingleCreateDraftInput;
  onHydrate: (draft: SingleCreateDraft) => void;
  delayMs?: number;
};

export function useSingleCreateDraft({
  ready,
  value,
  onHydrate,
  delayMs = 300,
}: UseSingleCreateDraftOptions) {
  const hydrateRef = useRef(onHydrate);
  const [hydrated, setHydrated] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<SingleCreateDraftStatus>("loading");

  useEffect(() => {
    hydrateRef.current = onHydrate;
  }, [onHydrate]);

  useEffect(() => {
    if (!ready || hydrated) return;

    const timer = window.setTimeout(() => {
      try {
        const draft = parseSingleCreateDraft(window.localStorage.getItem(SINGLE_CREATE_DRAFT_STORAGE_KEY)) as SingleCreateDraft | null;
        if (draft) hydrateRef.current(draft);
        setHydrated(true);
        setStatus(draft ? "saved" : "idle");
      } catch {
        setHydrated(true);
        setStatus("error");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [ready, hydrated]);

  useEffect(() => {
    if (!hydrated) return;

    const markSavingTimer = window.setTimeout(() => {
      setDirty(true);
      setStatus("saving");
    }, 0);
    const saveTimer = window.setTimeout(() => {
      try {
        // The JS parser owns runtime normalization; round-tripping through its
        // public boundary also keeps this hook's broad form-state type honest.
        const draft = parseSingleCreateDraft(JSON.stringify({ version: 1, ...value }));
        if (!draft) throw new Error("Unable to normalize Single Create draft.");
        window.localStorage.setItem(SINGLE_CREATE_DRAFT_STORAGE_KEY, JSON.stringify(draft));
        setDirty(false);
        setStatus("saved");
      } catch {
        setStatus("error");
      }
    }, delayMs);

    return () => {
      window.clearTimeout(markSavingTimer);
      window.clearTimeout(saveTimer);
    };
  }, [delayMs, hydrated, value]);

  useEffect(() => {
    if (!dirty) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  function clearDraft() {
    try {
      window.localStorage.removeItem(SINGLE_CREATE_DRAFT_STORAGE_KEY);
    } catch {
      // Navigation after a successful submit must not depend on storage access.
    }
    setDirty(false);
    setStatus("idle");
  }

  return {
    clearDraft,
    dirty,
    hydrated,
    status,
  };
}
