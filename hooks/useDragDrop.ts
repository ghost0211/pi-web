"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { listenDesktopFileDrop } from "@/lib/desktop";

export function useDragDrop(
  onDrop: (files: File[]) => void,
  onDesktopPathDrop?: (paths: string[]) => void,
) {
  const [isDragOver, setIsDragOver] = useState(false);
  const counterRef = useRef(0);
  const desktopPathDropRef = useRef(onDesktopPathDrop);
  desktopPathDropRef.current = onDesktopPathDrop;

  useEffect(() => {
    if (!onDesktopPathDrop) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenDesktopFileDrop({
      onEnter: () => {
        counterRef.current = 0;
        setIsDragOver(true);
      },
      onOver: () => setIsDragOver(true),
      onLeave: () => setIsDragOver(false),
      onDrop: (paths) => {
        counterRef.current = 0;
        setIsDragOver(false);
        if (paths.length) desktopPathDropRef.current?.(paths);
      },
    }).then((cleanup) => {
      if (disposed) cleanup?.();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [onDesktopPathDrop]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.length) return;
    // Accept any file drag (images and text/binary alike); the composer
    // decides per file type once dropped.
    if (!Array.from(e.dataTransfer.types).some((t) => t === "Files")) return;
    e.preventDefault();
    counterRef.current += 1;
    setIsDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer?.types?.length) return;
    if (!Array.from(e.dataTransfer.types).some((t) => t === "Files")) return;
    e.preventDefault();
  }, []);

  const handleDragLeave = useCallback(() => {
    counterRef.current -= 1;
    if (counterRef.current <= 0) {
      counterRef.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    counterRef.current = 0;
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    onDrop(files);
  }, [onDrop]);

  return { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop };
}
