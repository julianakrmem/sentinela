/**
 * Gerador de massa de dados 100% SINTÉTICA e determinística (semente fixa).
 *
 * Nenhum dado real de paciente é usado. Nomes são combinações aleatórias de
 * prenomes e sobrenomes comuns, sem vínculo com pessoas reais; idades e perfis
 * clínicos são sorteados. Mesma semente => mesma massa (testes reprodutíveis).
 *
 * Por que não Faker/Synthea? Ver docs/adr/0005-dados-sinteticos.md — em resumo:
 * só precisamos de identificação fictícia + séries fisiológicas em tempo real,
 * algo que nenhum dos dois entrega pronto; o gerador próprio evita dependência
 * pesada e garante reprodutibilidade. A interface `PatientIdentity` permite
 * trocar por @faker-js/faker (locale pt_BR) ou por pacientes exportados do Synthea.
 */

/** PRNG mulberry32: rápido, determinístico, suficiente para simulação (não criptográfico). */
export function createRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min,
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)]!,
    /** Normal(0,1) via Box–Muller. */
    gauss: () => {
      const u = Math.max(next(), 1e-12);
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    },
  };
}
export type Rng = ReturnType<typeof createRng>;

const FIRST_F = ['Ana', 'Beatriz', 'Camila', 'Daniela', 'Elaine', 'Fernanda', 'Gabriela', 'Helena', 'Isabela', 'Joana', 'Larissa', 'Marina', 'Natália', 'Olívia', 'Patrícia', 'Raquel', 'Sabrina', 'Tatiane', 'Vanessa', 'Yasmin'];
const FIRST_M = ['André', 'Bruno', 'Carlos', 'Diego', 'Eduardo', 'Felipe', 'Gustavo', 'Henrique', 'Igor', 'João', 'Leonardo', 'Marcos', 'Nicolas', 'Otávio', 'Paulo', 'Rafael', 'Samuel', 'Thiago', 'Vinícius', 'Wagner'];
const LAST = ['Almeida', 'Barbosa', 'Cardoso', 'Dias', 'Esteves', 'Ferreira', 'Gomes', 'Honorato', 'Lima', 'Moreira', 'Nogueira', 'Oliveira', 'Pereira', 'Queiroz', 'Ramos', 'Santos', 'Teixeira', 'Vieira', 'Xavier', 'Zanetti'];

export interface PatientIdentity {
  /** Nome fictício — exibido com o sufixo "(sintético)" no painel. */
  name: string;
  sex: 'F' | 'M';
  age: number;
}

export function syntheticIdentity(rng: Rng): PatientIdentity {
  const sex = rng.next() < 0.5 ? 'F' : 'M';
  const first = rng.pick(sex === 'F' ? FIRST_F : FIRST_M);
  const name = `${first} ${rng.pick(LAST)} ${rng.pick(LAST)}`;
  return { name, sex, age: rng.int(18, 94) };
}

const WARDS = ['UTI', 'SEMI', 'CM', 'PS'] as const;
export function bedLabel(index: number): { bedId: string; label: string } {
  const ward = WARDS[index % WARDS.length]!;
  const n = String(Math.floor(index / WARDS.length) + 1).padStart(3, '0');
  return { bedId: `${ward}-${n}`, label: `${ward} ${n}` };
}
