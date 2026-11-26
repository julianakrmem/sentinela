# ADR-0005 — Dados 100% sintéticos com gerador próprio determinístico

- **Status:** aceita
- **Data:** 2026-11-25

## Contexto

Este é um repositório público. Dados de saúde são **dados pessoais sensíveis** (LGPD, art. 5º, II e
art. 11): nenhum dado real de paciente, nem anonimizado, pode entrar no código, nos testes, nos logs
ou nas capturas de tela. Ainda assim, precisávamos de massa realista: identificação de leito/paciente
para o painel e **séries temporais fisiológicas** com pioras plausíveis.

## Decisão

1. **Nenhum dado real.** Tudo é gerado em tempo de execução por `sim/synthetic.ts` e `sim/patient-model.ts`.
2. **Gerador próprio com semente** (PRNG mulberry32 + Box–Muller):
   - nomes = prenome + 2 sobrenomes comuns sorteados, exibidos com o sufixo "(sintético)";
   - idade, sexo e perfil clínico sorteados;
   - seis perfis fisiológicos: estável, sepse (piora gradual), insuficiência respiratória aguda,
     DPOC em O2 (escala 2 de SpO2), em recuperação e "artefato" (picos isolados de sensor).
3. **Determinismo:** mesma `--seed` → mesmos pacientes e mesmas curvas → testes de carga comparáveis
   entre execuções e entre commits.
4. **Logs sem dados clínicos identificáveis:** o logger recebe só `bedId`, escore e metadados.

## Consequências

- ✅ Zero risco de vazamento; o repositório pode ser público sem ressalvas.
- ✅ Zero dependências de runtime para gerar carga; reprodutível no CI.
- ⚠️ O modelo fisiológico é **simplificado e com tempo comprimido** (pioras de horas acontecem em
  minutos). Serve para exercitar o software, não para validar o escore clinicamente.

## Alternativas consideradas

- **@faker-js/faker (locale `pt_BR`):** ótimo para identidades (nome, CPF fictício, endereço), mas não
  gera sinais vitais nem dinâmica temporal — só resolveria metade do problema. A interface
  `PatientIdentity` foi isolada para que trocar por `faker.person.fullName()` seja uma linha.
- **Synthea (MITRE):** gera prontuários sintéticos completos em FHIR, com histórico de doenças e
  observações. Excelente para popular cadastro/antecedentes, mas produz observações esparsas
  (consultas, internações), não fluxos contínuos de 1 Hz. Evolução natural: importar pacientes do
  Synthea como *identidade + comorbidades* e usar este simulador para a série em tempo real
  (ex.: pacientes com DPOC no Synthea → perfil `copd`, escala 2).
- **Bases públicas (MIMIC-IV, eICU):** dados reais desidentificados, exigem credenciamento e
  termo de uso que proíbe redistribuição — incompatível com repositório público.
