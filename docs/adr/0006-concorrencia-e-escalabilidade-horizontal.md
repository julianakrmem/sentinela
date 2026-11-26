# ADR-0006 — Fila serial por leito e escala horizontal por partição

- **Status:** aceita
- **Data:** 2026-11-25

## Contexto

O processamento de uma leitura é *read-modify-write*: lê o estado do leito, calcula, grava o novo
estado. Se duas leituras do mesmo leito forem processadas em paralelo, uma confirmação pode ser
perdida ou um alerta duplicado. Ao mesmo tempo, leitos diferentes não têm relação entre si e devem
ser processados com máximo paralelismo.

## Decisão

1. **`KeyedQueue`:** uma cadeia de promises por `bedId`. Leituras do mesmo leito executam em ordem,
   uma por vez; leitos diferentes são concorrentes. Ack do painel e watchdog passam pela mesma fila,
   então nunca disputam o estado com a ingestão.
2. **Backpressure:** cada leito aceita no máximo `MAX_QUEUE_PER_BED` (50) leituras pendentes; acima
   disso o gateway responde `error` (o dispositivo sabe que precisa reduzir ou reenviar) em vez de
   acumular memória até o processo cair.
3. **Escala horizontal:** instâncias são stateless (estado no Redis, ADR-0002). Para manter a
   garantia de ordem entre instâncias, cada leito deve ser atendido por **uma** instância por vez —
   balanceador com hash consistente por `bedId` (ou sticky session por conexão, já que cada monitor
   mantém uma conexão longa). O fan-out para painéis funciona entre instâncias via Pub/Sub.
4. **Painel em lote:** o hub agrega atualizações de leito e envia uma mensagem por segundo por
   navegador. Alertas e acks vão imediatamente.

## Consequências

- ✅ Sem locks distribuídos no caminho quente.
- ✅ Teste de estresse: 1 000 leitos a 2 Hz (~1 850 leituras/s) numa instância, fila sempre ~0.
- ⚠️ Se o balanceamento por leito falhar (duas instâncias recebendo o mesmo leito), a ordem não é
  garantida. Endurecimento possível: `WATCH`/`MULTI` otimista ou script Lua com número de versão
  no estado — deixado como evolução, documentado aqui.

## Alternativas consideradas

- **Lock distribuído (Redlock) por leito:** correto, mas acrescenta 2 round-trips por leitura e
  modos de falha complexos.
- **Script Lua fazendo todo o cálculo no Redis:** atômico, porém move regra clínica para dentro do
  banco, difícil de testar e versionar.
- **Kafka particionado por leito:** dá ordem por partição "de graça", mas ver ADR-0002 sobre custo operacional.
