---
paths:
  - "src/services/**/*.ts"
---

# Services Rules

- No direct Drizzle or OpenFGA client imports
- All access to the database is via repositories, and all access to OpenFGA is via the wrapper layer
