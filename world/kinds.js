// Semantic kinds shared by maps, themes, the engine, and the server. Themes draw them; they never carry behavior.
export const DECOR_KINDS = ["plant", "lamp", "rug", "sofa", "chair", "table", "whiteboard", "bookshelf", "screen", "banner", "poster", "statue", "fountain"];
export const BLOCKING_DECOR = new Set(["sofa", "table", "whiteboard", "bookshelf", "statue", "fountain"]);
export const THEMED_KINDS = [...DECOR_KINDS, "noticeboard"];
