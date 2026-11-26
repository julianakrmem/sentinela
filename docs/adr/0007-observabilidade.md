# ADR-0007 — Logs JSON, métricas Prometheus e health checks

- **Status:** aceita
- **Data:** 2026-11-25

## Contexto

Num sistema de alertas, o pior bug é o silencioso: o serviço "está no ar", mas parou de processar,
ou está processando com 2 s de atraso. Precisamos responder rápido: *está recebendo leituras? com
que latência? quantos alertas? o Redis responde?*

## Decisão

### Logs estruturados (JSON, uma linha por evento)

- Campos fixos: `level`, `time` (ISO-8601), `service`, `version`, `pid`, `component`, `msg`.
- Erros serializados com `type`, `message`, `stack`.
- Formato compatível com o do **pino**, ingerível por Loki, ELK ou CloudWatch sem parser.
- **Privacidade:** logs nunca recebem nome de paciente nem sinais vitais — só `bedId`, escore,
  prioridade e IDs de alerta (ver ADR-0005).
- Implementação própria (~50 linhas) para não acoplar o domínio a uma biblioteca; trocar por pino
  é substituir `createLogger`.

### Métricas (`GET /metrics`, formato de exposição Prometheus)

| Métrica | Tipo | Uso |
|---|---|---|
| `sentinela_readings_total` | counter | throughput |
| `sentinela_readings_rejected_total{reason}` | counter | validação / backpressure / interno |
| `sentinela_processing_duration_ms` | histogram | p50/p95/p99 com `histogram_quantile` |
| `sentinela_alerts_total{priority,kind}` | counter | volume de alertas (fadiga de alarmes) |
| `sentinela_alert_acks_total` | counter | tempo de resposta da equipe (com o anterior) |
| `sentinela_beds_by_priority{priority}` | gauge | quantos leitos críticos agora |
| `sentinela_ingest_connections`, `sentinela_dashboard_clients` | gauge | conexões |
| `sentinela_queue_depth`, `sentinela_event_loop_lag_ms`, `sentinela_heap_used_bytes` | gauge | saturação |
| `sentinela_storage_up` | gauge | Redis acessível (sondado a cada 10 s) |

O `docker-compose` sobe **Prometheus** (com regras de alerta operacionais em `ops/prometheus/alerts.yml`)
e **Grafana** com datasource e dashboard provisionados automaticamente (`ops/grafana/`).

### Health checks

- `GET /health/live` — *liveness*: o processo responde. Não checa dependências (evita que o
  orquestrador reinicie a app em cascata quando o Redis oscila).
- `GET /health/ready` — *readiness*: Redis responde ao `PING` **e** o event loop tem atraso < 1 s.
  Retorna 503 com o detalhe de cada checagem quando não está pronto.
- Ambos usados no `HEALTHCHECK` do Dockerfile e no `docker-compose.yml`.

## Consequências

- ✅ Os quatro sinais de ouro (latência, tráfego, erros, saturação) estão cobertos.
- ✅ Sem dependências: o registry Prometheus próprio tem ~100 linhas e testes.
- ⚠️ Sem tracing distribuído. Evolução: OpenTelemetry com um span por leitura
  (`ingest → score → trend → policy → publish`).

## Alternativas consideradas

- **prom-client + pino:** padrão de mercado, recomendados se o projeto crescer; a troca é localizada
  em `src/observability/`.
- **Logs em texto livre:** inviáveis para busca e alertas por campo.
