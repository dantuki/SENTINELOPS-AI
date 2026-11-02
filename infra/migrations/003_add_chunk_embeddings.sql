
BEGIN;

-- Añadir soporte para embeddings de 1536 dimensiones.
-- Los registros existentes permanecerán intactos.
ALTER TABLE document_chunks
    ADD COLUMN embedding vector(1536),
    ADD COLUMN embedding_model TEXT,
    ADD COLUMN embedding_updated_at TIMESTAMPTZ,
    ADD CONSTRAINT ck_document_chunks_embedding_metadata
        CHECK (
            (
                embedding IS NULL
                AND embedding_model IS NULL
                AND embedding_updated_at IS NULL
            )
            OR (
                embedding IS NOT NULL
                AND embedding_model IS NOT NULL
                AND btrim(embedding_model) <> ''
                AND embedding_updated_at IS NOT NULL
            )
        );

-- Índice para búsquedas por similitud del coseno.
-- Solo incluye fragmentos que ya tengan un embedding.
CREATE INDEX idx_document_chunks_embedding_hnsw
    ON document_chunks
    USING hnsw (embedding vector_cosine_ops)
    WHERE embedding IS NOT NULL;

COMMIT;
SELECT column_name, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'document_chunks'
  AND column_name IN (
      'embedding',
      'embedding_model',
      'embedding_updated_at'
  )
ORDER BY column_name;