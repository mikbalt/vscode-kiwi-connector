import type { TestCase } from '../kiwi/types';
import type { Session } from '../session';
import { chunk, unique } from '../util';

/** Test cases fetched from Kiwi, keyed by id. Also remembers ids that do not exist. */
export class CaseCache {
  private readonly cases = new Map<number, TestCase>();
  private readonly missing = new Set<number>();
  private readonly inFlight = new Map<number, Promise<void>>();

  constructor(private readonly session: Session) {}

  get(id: number): TestCase | undefined {
    return this.cases.get(id);
  }

  isMissing(id: number): boolean {
    return this.missing.has(id);
  }

  put(cases: TestCase[]): void {
    for (const c of cases) {
      this.cases.set(c.id, c);
      this.missing.delete(c.id);
    }
  }

  clear(): void {
    this.cases.clear();
    this.missing.clear();
  }

  /** Makes sure the given ids are loaded (one `TestCase.filter` per 200 unknown ids). */
  async ensure(ids: number[]): Promise<void> {
    if (!this.session.connected) {
      return;
    }
    const wanted = unique(ids);
    const waiting = wanted.map((id) => this.inFlight.get(id)).filter((p): p is Promise<void> => !!p);
    const need = wanted.filter((id) => !this.cases.has(id) && !this.missing.has(id) && !this.inFlight.has(id));

    for (const ids200 of chunk(need, 200)) {
      const request = this.session.api.filterCases({ pk__in: ids200 }).then((found) => {
        this.put(found);
        for (const id of ids200) {
          if (!this.cases.has(id)) {
            this.missing.add(id);
          }
        }
      });
      const tracked = request.finally(() => ids200.forEach((id) => this.inFlight.delete(id)));
      ids200.forEach((id) => this.inFlight.set(id, tracked));
      waiting.push(tracked);
    }
    await Promise.all(waiting);
  }
}
