# Contents

- `phase-orchestrator/` – phased execution with Codex collaboration agents and explicit join gates.
- `query-kb/` – scoped repository and knowledge-base retrieval.
- `plan-kb/` – durable implementation planning in the knowledge base.
- `percolate-kb/` – evidence-backed concept and relationship promotion.
- `refresh-kb/` – knowledge-graph refresh, context review, and validation.
- `save-url-kb/` – auditable public and signed-in web capture.
- `save-pdf-kb/` – auditable PDF conversion with OCR and image evidence.

# Guidelines

- Keep each reusable skill self-contained with `SKILL.md`, `AGENTS.md`, matching `agents/openai.yaml` metadata, and only the references it needs.
- Keep trigger descriptions precise and workflows portable across independently versioned repositories.
- Keep product-specific operational skills in the repository's root `skills/` directory when that directory exists; do not merge them into this reusable baseline.
- Update a skill's metadata and directory guide when its trigger, resources, or default invocation changes.
- Validate changed skill folders with the installed Codex skill validator when available.
