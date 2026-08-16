---
title: Repository seams
type: concept
tags:
  - architecture
  - dependencies
  - repositories
repository_scopes:
  - AGENTS.md
  - package.json
---

# Repository seams

Wrench is a foundational public CLI and SDK. It owns provider contracts, verified media archives, bounded capture operations, and the packaged Wrench skill. Consuming products own planning, agent loops, authentication policy, and application UI.

The runtime dependency on `@hraness/kb` is pinned to a full commit, and the development dependency on `@steipete/sweet-cookie` is pinned to an immutable codeload commit. Preserve those artifact boundaries. Do not replace them with sibling paths, Git submodules, or coordinated `main` workflows.

The dependency-free website remains a local documentation surface. New shared packages need two concrete consumers and a stable, product-neutral interface. Freeze a public contract before parallel implementation and give package manifests, generated catalogs, and other convergence files one owner.

## Related

The normative rules remain in the root `AGENTS.md`. [[documentation-ownership|Documentation ownership]] explains how those rules relate to executable contracts and this pull-based context.

