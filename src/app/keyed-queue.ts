/**
 * Fila serial por chave: leituras do MESMO leito são processadas em ordem e nunca
 * em paralelo (evita condição de corrida no read-modify-write do estado do leito),
 * enquanto leitos DIFERENTES são processados concorrentemente.
 */
export class BackpressureError extends Error {
  constructor(key: string, depth: number) {
    super(`fila do leito ${key} cheia (${depth} pendentes)`);
    this.name = 'BackpressureError';
  }
}

const noop = () => {};

export class KeyedQueue {
  private tails = new Map<string, Promise<void>>();
  private depths = new Map<string, number>();
  private total = 0;

  constructor(private readonly maxDepthPerKey = Infinity) {}

  get pending() { return this.total; }

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const depth = this.depths.get(key) ?? 0;
    if (depth >= this.maxDepthPerKey) return Promise.reject(new BackpressureError(key, depth));
    this.depths.set(key, depth + 1);
    this.total++;

    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(task);
    const tail: Promise<void> = result.then(noop, noop).then(() => {
      this.total--;
      const left = (this.depths.get(key) ?? 1) - 1;
      if (left <= 0) {
        this.depths.delete(key);
        if (this.tails.get(key) === tail) this.tails.delete(key);
      } else {
        this.depths.set(key, left);
      }
    });
    this.tails.set(key, tail);
    return result;
  }
}
