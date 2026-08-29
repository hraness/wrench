# Upstream

This five-skill pack is adapted from [`kousun12/code-orchestrator`](https://github.com/kousun12/code-orchestrator) at commit `989e49ba7b0d8cb922010272abe6748dd68a4adb`.

Local `AGENTS.md`, `agents/openai.yaml`, and `metadata.internal` integrate the pack with this repository's agent conventions. The `SKILL.md` workflows preserve the upstream role structure while adding local hardening: the parent creates implementation commits by default unless a plan opts out, every phase has a pre-review checkpoint and separate review-fix commits, the parent preserves plan state, logs, and phase topology, and remote stacked delivery remains gated by the target repository's authority.
