import { parseEmbedConfig, type EmbedConfig } from "./protocol";

/** Read once at load: embedded mode uses memory history, so the page address never changes. */
export const embedConfig: EmbedConfig =
  typeof window === "undefined"
    ? { embedded: false }
    : parseEmbedConfig({ search: window.location.search, framed: window.parent !== window });
