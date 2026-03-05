# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Uniqu — a pnpm monorepo for canonical query representation. Scoped under `@uniqu/`. Defines a transport-agnostic intermediate format for filters, sorting, pagination, and projection that can be parsed from various sources (URL query strings, JSON, SQL-like clauses) and rendered to various targets (SQL WHERE, MongoDB, ORM queries) via adapter callbacks.

## Packages

- **`@uniqu/core`** — canonical query format types (`FilterExpr<T>`, `Uniquery<T>`), generic tree walker (`walkFilter` with visitor pattern), lazy `computeInsights`, `isPrimitive` utility
- **`@uniqu/url`** — URL query string parser (`parseUrl`) producing the uniqu format with eagerly-computed insights. Contains lexer (`tokens.ts`), recursive descent parser (`parser.ts`), and main entry (`parse-url.ts`)

`@uniqu/url` depends on `@uniqu/core` via `workspace:^`. Core has zero dependencies.

## Commands

- `pnpm build` — build all packages (types via tsc + rollup-plugin-dts, bundles via Rolldown + SWC)
- `pnpm build <name>` — build a single package (e.g. `pnpm build core`)
- `pnpm test` — run all tests with vitest
- `pnpm test:watch` — vitest in watch mode
- `pnpm lint` — lint with oxlint
- `pnpm fmt` / `pnpm fmt:check` — format with oxfmt
- `pnpm release` — build, test, interactive version bump, tag, publish
- `pnpm sync` — sync versions across packages without publishing

## Architecture

Packages live in `packages/*/` and each produces ESM (.mjs), CJS (.cjs), and bundled .d.ts outputs in `dist/`.

The build system (`scripts/build.js`) runs in two phases:
1. **Types** — `tsc` emits declarations to `.types/`, then `rollup-plugin-dts` bundles them per-package
2. **Bundles** — Rolldown + SWC transpiles each entry to ESM and CJS

Per-package build config is declared in `package.json` under `"build"` (defaults: `entries: ["src/index.ts"]`, `format: ["esm", "cjs"]`, `dts: true`).

Cross-package imports use `workspace:^` protocol and TypeScript path aliases in `tsconfig.base.json`. Vitest resolves these via aliases in `vitest.config.ts`.

### Core design

- `Uniquery` is the single canonical query type: `{ name?, filter, controls, insights? }`. When `name` is present it's a nested `$with` relation; when absent it's the root query. `WithRelation` is just `Uniquery & { name: string }`.
- `FilterExpr<T>` is a recursive tree: `ComparisonNode<T>` (leaf with field→value/operators) or `LogicalNode<T>` (`$and`/`$or` wrapping children). Generic `T` defaults to `Record<string, unknown>` — provides type-safe fields when an entity shape is given, while always allowing arbitrary string keys for dot-notation paths.
- `walkFilter<R>(expr, visitor)` drives depth-first traversal. The visitor's 3 callbacks (`comparison`, `and`, `or`) control output — return `string` for SQL, `boolean` for validation, `void` for side-effects.
- `computeInsights(filter, controls?)` lazily builds a `Map<field, Set<operator>>` from an already-constructed query. Nested `$with` insights bubble up with dot-notation prefixed field names, and each relation gets its own scoped `insights`. The URL parser computes insights eagerly during parsing instead.

## Conventions

- Commits must follow [Conventional Commits](https://www.conventionalcommits.org/) (enforced by commitlint via husky)
- All packages share a single version (synced by `scripts/versions.js`)
- Package exports must list `types` condition first, then `import`, then `require`
- New packages: create `packages/<name>/` with `package.json`, `tsconfig.json`, `src/index.ts`, then add path aliases to both `tsconfig.base.json` and `vitest.config.ts`
- Tests are colocated with source as `*.spec.ts` files
