# General Architecture Rules

- The service layer owns all business logic and is the ONLY layer that accesses repositories and the OpenFGA layer.
- The transactional outbox pattern is used for all dual-writes to the DB and OpenFGA. A DB transaction atomically writes the business record + an outbox row. A separate worker delivers outbox events to OpenFGA.
