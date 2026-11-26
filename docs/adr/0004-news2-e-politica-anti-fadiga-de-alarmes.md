# ADR-0004 — NEWS2 como escore e política de alertas anti-fadiga

- **Status:** aceita
- **Data:** 2026-11-25

## Contexto

Precisávamos de um escore de alerta precoce validado e de uma regra para transformar escore em
notificação. O risco clássico de sistemas de monitorização é a **fadiga de alarmes**: alertas
demais, muitos falsos (sensor solto, movimento), e a equipe passa a ignorá-los.

## Decisão

### Escore: NEWS2 (Royal College of Physicians, 2017)

- Sete parâmetros: FR, SpO2 (escalas 1 e 2), O2 suplementar, PAS, FC, consciência (ACVPU), temperatura.
- Faixas de risco: 0–4 baixo; parâmetro isolado = 3 → baixo-médio; 5–6 médio; ≥ 7 alto.
- Implementado como **funções puras** com teste em cada limite de faixa da tabela.

### Prioridade operacional

| Situação | Prioridade |
|---|---|
| NEWS2 ≥ 7 | `CRITICAL` |
| NEWS2 5–6 | `HIGH` |
| Algum parâmetro com 3 pontos | `MEDIUM` |
| Tendência de piora na janela | +1 degrau (teto `HIGH`) |

A tendência nunca cria um `CRITICAL` sozinha: ela antecipa, mas quem define emergência é o escore.

### Política (máquina de estados por leito, `alert-policy.ts`)

1. **Confirmação:** escalar exige `CONFIRM_READINGS` (padrão 2) leituras consecutivas acima do
   nível atual. Um artefato isolado não alerta. Com monitores a 1 Hz isso custa ~1 s.
2. **Escalona para o menor nível confirmado:** CRITICAL seguido de HIGH confirma HIGH.
3. **Lembretes** enquanto não houver reconhecimento: CRITICAL 1 min, HIGH 5 min, MEDIUM 15 min.
4. **Reconhecimento (ack)** silencia lembretes por 10 min — não silencia uma *nova* escalada.
5. **Histerese na desescalada:** só baixa após 60 s e ≥ 3 leituras abaixo; desce para o
   **maior** nível visto nesse período (conservador).
6. **Perda de sinal:** monitor mudo por 15 s gera alerta (HIGH se o paciente já estava ≥ HIGH).

## Consequências

- ✅ No teste de carga, os leitos com perfil "artefato" (picos isolados de SpO2 55–78% e FC 165–210)
  geraram **zero** alertas, enquanto pioras reais escalaram em ~2 s.
- ✅ A política é uma função pura `(estado, entrada) → (novo estado, eventos)`: 100% testável sem I/O.
- ⚠️ Confirmação atrasa em 1 leitura a notificação de uma parada súbita. Em produção, ritmos
  letais (assistolia/FV) viriam do próprio monitor, não deste motor de tendência.
- ⚠️ Os tempos são parâmetros de configuração, não verdade clínica — devem ser definidos com a
  equipe assistencial e validados localmente.

## Alternativas consideradas

- **MEWS:** mais antigo, sem padronização nacional e sem escala de SpO2 para DPOC. NEWS2 é
  recomendado pelo NHS e amplamente validado; a interface `computeNews2` permite somar um
  `computeMews` depois.
- **Alertar a cada leitura acima do limiar:** simples e inaceitável — o painel vira árvore de Natal.
- **Média móvel em vez de confirmação:** suaviza, mas atrasa mais e distorce limites de faixa.
