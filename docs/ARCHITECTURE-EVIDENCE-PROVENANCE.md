# Evidence provenance and retrieval trace

Authority flows as: runner → request → Product API retrieval event → retrieved chunk → document → source → evidence manifest → model citation candidate → evaluator claim verification. Product API owns chunk identity, rank, score, scope, and content hash. The model may emit `E<n>` only; it cannot authoritatively choose support status.

The trace is application-append-only. No database immutability guarantee is claimed because deployment privileges/triggers have not been inspected. General project context is retained but must not be presented as an incident event. The verifier recomputes SHA-256 over the exact UTF-8 database `content`, and rejects any same-run/request, lineage, state, scope, or byte mismatch.

Implemented: trace persistence types, SQL repository, migration, manifest builder, and read-only verifier. Tested with mocks: not yet. Validated against simulated queries: not yet. Validated against temporary PostgreSQL, Ollama, or INC-001: not performed.
