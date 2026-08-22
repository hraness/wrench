# Contents

- `negotiation.ts` – Edge-safe Accept parsing and markdown, 406, and 404 negotiation.
- `tsconfig.json` – Web Worker lib and no Bun, Node, or website types.
- `../middleware.ts` – Vercel Edge entry that imports only this directory.

# Guidelines

- Keep every file here free of Node, Bun, website build, and filesystem imports.
- Honor Accept q-values, set `Vary: Accept`, and return `406` only when no owned representation remains.
- Unknown document paths stay HTTP 404 and serve the static markdown 404 body.
