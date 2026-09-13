---
"@moonshot-ai/kimi-code": minor
---

Add an experimental `hook_permission_decisions` flag that lets `PermissionRequest` hooks approve or deny a tool approval instead of showing the prompt. Enable it under `[experimental]` in `config.toml` to let hooks decide approvals.
