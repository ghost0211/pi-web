import {
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
} from "./image-attachments";
import type { AttachedTextFile, AttachedBinaryFile, AttachedLocalFile } from "./file-attachments";

export interface ChatDraftImage {
  data: string;
  mimeType: string;
}

export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
  textFiles: AttachedTextFile[];
  binaryFiles: AttachedBinaryFile[];
  localFiles: AttachedLocalFile[];
}

const drafts = new Map<string, ChatDraft>();

function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
    textFiles: draft.textFiles.map((file) => ({ ...file })),
    binaryFiles: draft.binaryFiles.map((file) => ({ ...file })),
    localFiles: draft.localFiles.map((file) => ({ ...file })),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value
    && draft.images.length === 0
    && draft.textFiles.length === 0
    && draft.binaryFiles.length === 0
    && draft.localFiles.length === 0;
}

export function getDraft(key: string): ChatDraft | null {
  const draft = drafts.get(key);
  return draft ? cloneDraft(draft) : null;
}

export function setDraft(key: string, draft: ChatDraft): void {
  if (isEmptyDraft(draft)) {
    drafts.delete(key);
    return;
  }
  drafts.set(key, cloneDraft(draft));
}

export function clearDraft(key: string): void {
  drafts.delete(key);
}

export function mergeRestoredSubmissionText(submitted: string, current: string): string {
  if (!submitted.trim()) return current;
  if (!current.trim()) return submitted;
  return `${submitted}\n\n${current}`;
}

export function mergeRestoredSubmissionDraft(
  submittedText: string,
  submittedImages: ChatDraftImage[] | undefined,
  submittedTextFiles: AttachedTextFile[] | undefined,
  submittedBinaryFiles: AttachedBinaryFile[] | undefined,
  submittedLocalFiles: AttachedLocalFile[] | undefined,
  currentText: string,
  currentImages: ChatDraftImage[],
  currentTextFiles: AttachedTextFile[],
  currentBinaryFiles: AttachedBinaryFile[],
  currentLocalFiles: AttachedLocalFile[],
): ChatDraft {
  const images = [...(submittedImages ?? []), ...currentImages]
    .filter(isBase64ImageWithinLimits)
    .slice(0, MAX_ATTACHED_IMAGES)
    .map(({ data, mimeType }) => ({ data, mimeType }));

  const textFiles = [...(submittedTextFiles ?? []), ...currentTextFiles];
  const seenText = new Set<string>();
  const dedupedText = textFiles.filter((file) => {
    const key = `${file.name}\u0000${file.size}`;
    if (seenText.has(key)) return false;
    seenText.add(key);
    return true;
  });

  const binaryFiles = [...(submittedBinaryFiles ?? []), ...currentBinaryFiles];
  const seenBinary = new Set<string>();
  const dedupedBinary = binaryFiles.filter((file) => {
    const key = `${file.name}\u0000${file.size}\u0000${file.data.length}`;
    if (seenBinary.has(key)) return false;
    seenBinary.add(key);
    return true;
  });

  const localFiles = [...(submittedLocalFiles ?? []), ...currentLocalFiles];
  const seenLocal = new Set<string>();
  const dedupedLocal = localFiles.filter((file) => {
    if (seenLocal.has(file.path)) return false;
    seenLocal.add(file.path);
    return true;
  });

  return {
    value: mergeRestoredSubmissionText(submittedText, currentText),
    images,
    textFiles: dedupedText,
    binaryFiles: dedupedBinary,
    localFiles: dedupedLocal,
  };
}

export function restoreDraftSubmission(
  key: string,
  text: string,
  images?: ChatDraftImage[],
  textFiles?: AttachedTextFile[],
  binaryFiles?: AttachedBinaryFile[],
  localFiles?: AttachedLocalFile[],
): ChatDraft {
  const current = getDraft(key) ?? { value: "", images: [], textFiles: [], binaryFiles: [], localFiles: [] };
  const restored = mergeRestoredSubmissionDraft(
    text,
    images,
    textFiles,
    binaryFiles,
    localFiles,
    current.value,
    current.images,
    current.textFiles,
    current.binaryFiles,
    current.localFiles,
  );
  setDraft(key, restored);
  return restored;
}

export function rekeyDraft(
  previousKey: string,
  nextKey: string,
  currentDraft?: ChatDraft,
): ChatDraft | null {
  if (previousKey === nextKey) return currentDraft ? cloneDraft(currentDraft) : getDraft(nextKey);

  const storedPrevious = getDraft(previousKey);
  const previous = currentDraft && !isEmptyDraft(currentDraft)
    ? cloneDraft(currentDraft)
    : (storedPrevious ?? (currentDraft ? cloneDraft(currentDraft) : null));
  const next = getDraft(nextKey);
  clearDraft(previousKey);
  if (!previous) return next;

  const merged = next
    ? mergeRestoredSubmissionDraft(
        next.value,
        next.images,
        next.textFiles,
        next.binaryFiles,
        next.localFiles,
        previous.value,
        previous.images,
        previous.textFiles,
        previous.binaryFiles,
        previous.localFiles,
      )
    : previous;
  setDraft(nextKey, merged);
  return cloneDraft(merged);
}
