"use client";

import { useCallback, useEffect, useState } from "react";

export type FontSizePreference = "small" | "medium" | "large" | "xlarge";

const FONT_SIZE_STORAGE_KEY = "pi-web:font-size";
const DEFAULT_FONT_SIZE: FontSizePreference = "medium";

function applyFontSizeClass(size: FontSizePreference) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-font-size", size);
}

function readStoredFontSize(): FontSizePreference {
  if (typeof window === "undefined") return DEFAULT_FONT_SIZE;
  try {
    const raw = window.localStorage.getItem(FONT_SIZE_STORAGE_KEY);
    if (raw === "small" || raw === "medium" || raw === "large" || raw === "xlarge") {
      return raw;
    }
  } catch {
    // ignore quota/privacy errors
  }
  return DEFAULT_FONT_SIZE;
}

export function useFontSize() {
  const [fontSize, setFontSizeState] = useState<FontSizePreference>(DEFAULT_FONT_SIZE);

  useEffect(() => {
    const initial = readStoredFontSize();
    setFontSizeState(initial);
    applyFontSizeClass(initial);
  }, []);

  const setFontSize = useCallback((size: FontSizePreference) => {
    setFontSizeState(size);
    applyFontSizeClass(size);
    try {
      window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, size);
    } catch {
      // ignore
    }
  }, []);

  return { fontSize, setFontSize };
}
