# ADR-0002 — Redis para estado quente, janela temporal e mensageria

- **Status:** aceita
- **Data:** 2026-11-25

## Contexto

Cada leitura (até ~1 Hz por leito, centenas de leitos) precisa de:

1. o **estado do leito** (nível de alerta atual, confirmações pendentes, ack) — leitura e escrita por evento;
2. a **janela temporal recente** (últimos 15 min) para detectar tendência de piora;
3. **fan-out em tempo real** dos alertas para todos os painéis, inclusive conectados a outras instâncias;
4. **replay** dos últimos alertas para um painel que acabou de abrir.

Os dados são *quentes* e de vida curta: depois de 15 minutos a janela não interessa mais ao motor
(o histórico de longo prazo pertence ao prontuário/data lake, fora do escopo).

## Decisão

Usar **Redis** como única dependência de infraestrutura, explorando estruturas nativas:

| Necessidade | Estrutura | Por quê |
|---|---|---|
| Janela temporal | `ZSET` (score = timestamp) | `ZADD` + `ZREMRANGEBYSCORE` poda a janela em O(log n); `ZRANGE` devolve em ordem temporal |
| Estado do leito | `STRING` JSON com TTL | leitura/escrita O(1); TTL limpa leitos esquecidos |
| Snapshot do painel | `HASH` `beds:latest` | um `HGETALL` monta a tela inteira |
| Perda de sinal | `ZSET` `beds:lastseen` | `ZRANGEBYSCORE -inf (agora-15s` acha monitores mudos sem varrer tudo |
| Fan-out em tempo real | Pub/Sub | latência sub-ms, todas as instâncias recebem |
| Replay de alertas | `STREAM` com `MAXLEN ~` | log ordenado, limitado, com IDs monotônicos |

Escritas relacionadas vão num `MULTI/EXEC` (estado + snapshot + publicação são atômicos) e o cliente
usa *auto-pipelining* do ioredis para agrupar comandos concorrentes num só round-trip.

As chaves por leito usam *hash tag* (`sentinela:bed:{UTI-001}:state`), então num Redis Cluster
todas as chaves de um leito caem no mesmo slot e o `MULTI` continua válido.

A janela guarda **amostras a cada 5 s** (não toda leitura) em formato compacto
(`ts|news2|hr|spo2|sbp|rr|temp`, ~35 bytes): 15 min = 180 pontos/leito ≈ 6 KB.
1 000 leitos ≈ 6 MB de RAM.

## Consequências

- ✅ Latência medida: p95 de 2 ms ponta a ponta com 500 leitos a 1 Hz (ver README).
- ✅ Instâncias da aplicação ficam *stateless* — podem reiniciar sem perder o estado clínico.
- ⚠️ Pub/Sub é *fire-and-forget*: um painel desconectado perde mensagens. Mitigação: ao reconectar
  ele recebe snapshot + replay do Stream.
- ⚠️ Redis em memória: um crash sem persistência perde ~15 min de janela. Aceitável — a tendência se
  reconstrói em minutos e o escore instantâneo não depende dela. Em produção: AOF `everysec` + réplica.
- ⚠️ Persistência de longo prazo/auditoria **não** é papel deste serviço (ver "Alternativas").

## Alternativas consideradas

- **PostgreSQL/TimescaleDB:** ótimo para histórico e consultas analíticas, mas cada leitura viraria
  um INSERT + SELECT da janela; latência e carga de escrita maiores para um dado que expira em 15 min.
  Seria o destino natural de um consumidor do Stream para auditoria.
- **Kafka:** excelente log durável e particionamento, mas pesado para o escopo (ZooKeeper/KRaft,
  operação) e não resolve o estado por leito sem um state store (Kafka Streams/Flink).
- **Somente memória do processo:** mais rápido, mas impede escala horizontal e perde tudo no deploy.
  Mantido apenas como adaptador de desenvolvimento/testes (`MemoryStorage`).
