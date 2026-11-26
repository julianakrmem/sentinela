# ADR-0003 — WebSocket (e não MQTT) para ingestão

- **Status:** aceita
- **Data:** 2026-11-25

## Contexto

Os monitores (simulados) precisam enviar leituras continuamente, e o painel de enfermagem precisa
receber alertas em tempo real. As opções óbvias eram **WebSocket** e **MQTT**.

## Decisão

Usar **WebSocket** nos dois sentidos, com dois endpoints no mesmo servidor HTTP:

- `/ws/ingest` — monitores enviam `hello`/`vitals`/`bye` e recebem `ack` com o NEWS2 calculado;
- `/ws/dashboard` — navegadores recebem snapshot, alertas e lotes de atualização.

O protocolo é JSON simples, versionável por `type`, validado sem dependências (`validation.ts`).

## Consequências

- ✅ Um único protocolo e uma única porta para dispositivos e navegador; nenhum broker extra.
- ✅ O `ack` por leitura dá ao dispositivo confirmação de entrega **e** permite medir o tempo de
  ida e volta no teste de carga (latência real percebida, não só tempo interno).
- ✅ Heartbeat (ping/pong a cada 30 s) derruba conexões meio-abertas.
- ⚠️ Sem QoS nativo: se o servidor cair, leituras em voo se perdem. Aceitável — a próxima leitura
  chega em ~1 s e o watchdog sinaliza monitores mudos.
- ⚠️ Escala horizontal exige *sticky sessions* ou balanceamento por leito (ver ADR-0006).

## Alternativas consideradas

- **MQTT (Mosquitto/EMQX):** padrão em IoT, QoS 1/2, sessões persistentes e tópicos hierárquicos
  (`ward/UTI/bed/001/vitals`). Seria a escolha para dispositivos reais com rede instável.
  Ficou de fora para manter a stack enxuta; a arquitetura já está preparada: o `TriageService`
  não conhece o transporte, então um `mqtt-gateway.ts` que assine `+/+/vitals` e chame
  `service.ingest()` é um adaptador de ~50 linhas.
- **HL7 v2 / FHIR Observation:** é o que integraria com o hospital de verdade. Fora do escopo de um
  projeto de portfólio, mas o modelo `VitalSigns` mapeia diretamente para `Observation` com códigos LOINC.
- **Server-Sent Events para o painel:** suficiente para servidor → cliente, mas o ack do alerta
  precisaria de um endpoint HTTP separado. WebSocket simplifica.
