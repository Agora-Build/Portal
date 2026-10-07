# Repository Guidelines

## Project Structure & Module Organization

This is the static Agora Build community portal. `index.html` contains the homepage; `explore.html` contains the project directory. Shared styling lives in `styles.css`, navigation and featured filters in `script.js`, and directory search, categories, and sorting in `explore.js`. SVG artwork and the favicon live in `assets/`. Node tooling lives in `scripts/`; automated checks live in `tests/`. Generated deployment files go into `dist/`.

## Build, Test, and Development Commands

Use Node.js 20 or newer; no dependency installation is required.

- `npm run dev`: serve the site at `http://localhost:3000`.
- `npm run dev -- --port 4173`: choose another local port.
- `npm test`: check pages, asset delivery, navigation, server restrictions, and production output.
- `npm run build`: copy the public site into `dist/`.
- `npm run preview`: serve the built site locally.

## Coding Style & Naming Conventions

Use two spaces for multiline indentation, double quotes and semicolons in JavaScript, and descriptive kebab-case CSS classes. Node scripts use `.mjs` and built-in modules. No formatter or linter is configured. Preserve the restrained paper, terracotta, and charcoal palette, expressive typography, and shared CSS variables. Prefer semantic HTML, accessible names, and native buttons; respect reduced-motion preferences.

## Testing Guidelines

Tests use the built-in Node test runner and are named `*.test.mjs`. Run `npm test` before proposing changes. No coverage threshold is configured. For interface changes, verify both pages at desktop and mobile widths, keyboard navigation, category filters, combined searches, sorting, URL restoration, and empty results.

## Commit & Pull Request Guidelines

This directory began without Git metadata, so historical commit conventions are unavailable. Use concise imperative subjects, such as `Add real-time project filters`. Include the change rationale, verification commands, related issues, and desktop/mobile screenshots for visual changes.

Every commit must end with `🤖 Built with SMT <smt@agora.build>`. Every pull request body must end with `Generated with SMT <smt@agora.build>`. Do not add co-author trailers.

## Content & Configuration

Verify descriptions and project links against Agora-Build on GitHub. Refresh repository totals and activity ordering when updating the directory. Keep credentials out of source, documentation, and agent memory; retain only credential names.
