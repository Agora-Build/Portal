import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateTheme } from "../../world/themes.js";
import { THEMES } from "./model.mjs";

// Built-in themes are validated at startup so a broken theme can never reach a browser.
export function loadThemes(directory) {
  return THEMES.map((id) => {
    const theme = JSON.parse(readFileSync(resolve(directory, "themes", id, "theme.json"), "utf8"));
    const errors = validateTheme(theme);
    if (theme.id !== id) errors.push("Its id does not match its folder.");
    if (errors.length) throw new Error("Theme " + id + " is invalid: " + errors.join(" "));
    return theme;
  });
}
