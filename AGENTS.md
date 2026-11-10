# MetaInfer — permanent agent rules

These rules are binding for every coding agent working in this repository.

## 先读架构入口

改动 `dsh-metainfer-research-lab/` 之前，先读 [`docs/00-system-map.md`](dsh-metainfer-research-lab/docs/00-system-map.md)：
它给出分层、Agent 在哪几层、三个入口一个门面、以及四个已知的坑（全局工具注册、anchor 空壳、
重试重置 session、Host 负责 commit）。文档与代码冲突时以代码为准，并在 `docs/issues/` 记一条。

## No one-off product patches

Never add project-specific, environment-specific, or request-specific code to product code merely to satisfy one immediate request. In particular, do not ship any of the following:

- a hardcoded project id, session id, zip filename, download URL, port, hostname, or repository path in UI or Host routes;
- a static file copied to a runtime directory and linked from the product UI;
- a `/tmp` script used as a runtime dependency;
- a one-off button, menu item, route, or agent-tool action that only works for one project;
- fake/placeholder data, fake success, or a prototype presented as a feature.

If a request needs a capability, implement the general capability: service + API + UI, parameterized by project/entity, with tests, lifecycle, error handling, and security. If a throwaway investigation is needed, keep it outside the repository, do not wire it into product code, and remove it when done.

## Required shape for new features

1. Data/state layer with a reusable function or service.
2. A general API/route that takes explicit identifiers; no hardcoded ids.
3. UI discoverable by the relevant entity, with loading/error/empty states.
4. Tests covering at least one successful path and one failure path.
5. Documentation for limits and lifecycle (retention, cleanup, auth).

## Cleanup

Scratch files, one-off exports, diagnostic actions, temporary routes, and debug-only UI controls must not remain in the final change. If a temporary artifact is needed for the user, keep it outside the repository and say so explicitly.
