---
paths:
  - "src/plugins/**/*.ts"
---

# Rules for Plugins

- Do not access OpenFGA and Drizzle directly
- Only call services that contain business logic. Do not call Drizzle or OpenFGA.
