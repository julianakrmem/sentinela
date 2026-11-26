# ADR-0001 — Registrar decisões de arquitetura

- **Status:** aceita
- **Data:** 2026-11-25

## Contexto

Um sistema de alertas clínicos é cheio de escolhas que parecem arbitrárias para quem chega depois
(por que 2 leituras para confirmar? por que Redis e não Postgres?). Sem registro, essas
decisões viram folclore e são desfeitas por acidente.

## Decisão

Usar ADRs no formato de Michael Nygard em `docs/adr/`, numerados sequencialmente, com
**Contexto → Decisão → Consequências → Alternativas consideradas**. Um ADR aceito não é
editado; se a decisão mudar, cria-se um novo ADR que o substitui (status "substituída por ADR-00XX").

## Consequências

- Revisões de código podem apontar para o ADR em vez de repetir a discussão.
- Custo baixo: um arquivo Markdown por decisão relevante.

## Índice

| ADR | Decisão |
|-----|---------|
| [0002](0002-redis-para-estado-quente-e-janela-temporal.md) | Redis para estado quente, janela temporal e mensageria |
| [0003](0003-websocket-para-ingestao.md) | WebSocket (e não MQTT) para ingestão |
| [0004](0004-news2-e-politica-anti-fadiga-de-alarmes.md) | NEWS2 + política de alertas anti-fadiga |
| [0005](0005-dados-sinteticos.md) | Dados 100% sintéticos com gerador próprio determinístico |
| [0006](0006-concorrencia-e-escalabilidade-horizontal.md) | Fila serial por leito e escala horizontal por partição |
| [0007](0007-observabilidade.md) | Logs JSON, métricas Prometheus e health checks |
