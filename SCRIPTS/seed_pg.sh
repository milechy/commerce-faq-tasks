#!/usr/bin/env bash
set -e
psql 'postgres://postgres:pass@127.0.0.1:5434/postgres' -tAc "SELECT 1 FROM pg_database WHERE datname='faq'" | grep -q 1 || psql 'postgres://postgres:pass@127.0.0.1:5434/postgres' -c 'CREATE DATABASE faq;'
psql 'postgres://postgres:pass@127.0.0.1:5434/faq' -c 'CREATE EXTENSION IF NOT EXISTS vector;'
psql 'postgres://postgres:pass@127.0.0.1:5434/faq' -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm;'
psql 'postgres://postgres:pass@127.0.0.1:5434/faq' -c "CREATE TABLE IF NOT EXISTS docs (id serial PRIMARY KEY, text text NOT NULL);"
psql 'postgres://postgres:pass@127.0.0.1:5434/faq' -c "CREATE INDEX IF NOT EXISTS docs_text_trgm ON docs USING gin (text gin_trgm_ops);"
psql 'postgres://postgres:pass@127.0.0.1:5434/faq' -tAc "SELECT 1 FROM information_schema.table_constraints WHERE table_name='docs' AND constraint_name='docs_text_unique'" | grep -q 1 || psql 'postgres://postgres:pass@127.0.0.1:5434/faq' -c "ALTER TABLE docs ADD CONSTRAINT docs_text_unique UNIQUE (text);"
psql 'postgres://postgres:pass@127.0.0.1:5434/faq' -c "INSERT INTO docs(text) VALUES ('【PG】返品 送料 の考え方：一定条件で当社負担'), ('【PG】配送と返品 送料 のFAQ：セール品除外の場合あり') ON CONFLICT (text) DO NOTHING;"
echo 'PG seeded'