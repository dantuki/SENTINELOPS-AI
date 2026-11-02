BEGIN;

-- No cambiar la dimensión si ya existen embeddings guardados.
-- Los vectores anteriores no son compatibles con el nuevo modelo.
DO $migration$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM document_chunks
        WHERE embedding IS NOT NULL
    ) THEN
        RAISE EXCEPTION
            'Migration aborted: existing embeddings must be migrated or regenerated before changing dimensions.';
    END IF;
END
$migration$;

-- El índice existente depende del tipo vectorial anterior.
DROP INDEX IF EXISTS idx_document_chunks_embedding_hnsw;

-- Cambiar la dimensión sin modificar el contenido de los fragmentos.
ALTER TABLE document_chunks
    ALTER COLUMN embedding TYPE vector(1024)
    USING embedding::vector(1024);

-- Recrear el índice para búsquedas por similitud del coseno.
CREATE INDEX idx_document_chunks_embedding_hnsw
    ON document_chunks
    USING hnsw (embedding vector_cosine_ops)
    WHERE embedding IS NOT NULL;

COMMIT;