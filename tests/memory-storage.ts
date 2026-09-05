/**
 * An in-memory Storage, because the persisted stores are validated against
 * whatever else shares the origin and that is worth testing. Not a *.test.ts, so
 * vitest does not try to run it.
 */
export class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

/** Installs a fresh store as globalThis.localStorage and hands it back. */
export function installStorage(): MemoryStorage {
  const store = new MemoryStorage();
  Object.defineProperty(globalThis, 'localStorage', { value: store, configurable: true, writable: true });
  return store;
}
