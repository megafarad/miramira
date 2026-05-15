---
paths: 
  - "src/repositories/**/*.ts"
---

# Repository design rules

- No business logic. Only contain data access logic, and do nothing but query/mutate data.
- Create interfaces for repositories that are implemented and injected.
- Drizzle dependencies should be dependency-injected.
