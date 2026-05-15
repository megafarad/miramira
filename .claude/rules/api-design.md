---
paths:
  - "src/routes/**/*.ts"
---

# API Design Rules

- No business logic, data access logic, or OpenFGA logic.
- All business logic should be in a service, and routes call services for all business logic.
- All endpoints should validate input with Zod schema
- Return shape: { data: T } | { error: string }
- Rate limit all public endpoints
