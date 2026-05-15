---
paths: 
  - "src/services/**/*.ts"
  - "src/workers/**/*.ts"
---

# Dual-write Rules

- Workers only call the service layer, which in turn has logic to call the repository for outbox rows, and calls the OpenFGA layer to execute reads/writes on OpenFGA tuples.
- Workers should have no direct access to Drizzle, or the OpenFGA client.
