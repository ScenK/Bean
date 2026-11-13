import { attachNoteImages, MAX_NOTE_IMAGE_BYTES, type ImageAttachment, type Note, type NoteDraft } from "@bean/core";

export interface NotesHandlerDeps {
  loadNotes: (file: string, opts?: { includeArchived?: boolean }) => Promise<Note[]>;
  saveNote: (file: string, draft: NoteDraft) => Promise<string>;
  archiveNote: (file: string, slug: string) => Promise<boolean>;
  restoreNote: (file: string, slug: string) => Promise<boolean>;
  purgeNote: (file: string, slug: string) => Promise<boolean>;
  starNote: (file: string, slug: string, starred: boolean) => Promise<void>;
  loadNoteHistory: (file: string, slug: string) => Promise<Note[]>;
  saveNoteImage: (file: string, bytes: Uint8Array) => Promise<string>;
  loadNoteImage: (file: string, id: string) => Promise<{ mime: string; bytes: Uint8Array } | undefined>;
  dbFile: string;
}

// Slugs cross IPC untyped; core re-checks traversal, this rejects non-strings before it.
function noteSlug(slug: unknown): string {
  if (typeof slug !== "string" || slug === "") throw new Error("invalid note slug");
  return slug;
}

export function buildNotesHandlers(deps: NotesHandlerDeps) {
  const storeImage = (bytes: Uint8Array): Promise<string> => deps.saveNoteImage(deps.dbFile, bytes);
  return {
    list: (opts?: unknown): Promise<Note[]> =>
      deps.loadNotes(deps.dbFile, { includeArchived: (opts as { includeArchived?: unknown } | undefined)?.includeArchived === true }),
    // `images` = the chat's latest attached images carried into a desktop propose_note save;
    // core stores them and appends code-written bean-image refs (limits re-checked there).
    save: async (draft: NoteDraft, images?: unknown): Promise<string> => {
      const valid = Array.isArray(images)
        ? images.filter((i): i is ImageAttachment => typeof (i as ImageAttachment)?.data === "string")
        : [];
      const body = valid.length > 0 ? await attachNoteImages(storeImage, draft.body, valid) : draft.body;
      // Copy known fields only — never spread the renderer payload into core.
      const { title, project, source, slug } = draft;
      return deps.saveNote(deps.dbFile, { title, body, project, source, slug });
    },
    // Trust boundary for editor paste/drop: bytes only, never a path; size capped here before
    // storing, format checked by magic bytes in core.
    saveImage: (bytes: unknown): Promise<string> => {
      if (!(bytes instanceof Uint8Array)) return Promise.reject(new Error("note image must be raw bytes"));
      if (bytes.byteLength > MAX_NOTE_IMAGE_BYTES) return Promise.reject(new Error("image is larger than 10 MB"));
      return storeImage(bytes);
    },
    /** A stored note image as a data: URL, or undefined for an unknown/malformed id. */
    image: async (id: unknown): Promise<string | undefined> => {
      if (typeof id !== "string") return undefined;
      const img = await deps.loadNoteImage(deps.dbFile, id);
      return img ? `data:${img.mime};base64,${Buffer.from(img.bytes).toString("base64")}` : undefined;
    },
    archive: async (slug: unknown): Promise<void> => { await deps.archiveNote(deps.dbFile, noteSlug(slug)); },
    restore: async (slug: unknown): Promise<void> => { await deps.restoreNote(deps.dbFile, noteSlug(slug)); },
    purge: async (slug: unknown): Promise<void> => {
      if (!(await deps.purgeNote(deps.dbFile, noteSlug(slug)))) throw new Error("only an archived note can be deleted permanently");
    },
    star: (slug: string, starred: boolean): Promise<void> => deps.starNote(deps.dbFile, slug, starred),
    history: (slug: string): Promise<Note[]> => deps.loadNoteHistory(deps.dbFile, slug),
  };
}
