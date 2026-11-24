/* The engine's find in the note (docs/spec/editor/portable-core/find.md), as the page calls it:
 * ranges in display bytes, results parsed. The engine owns every rule: what matches, which match
 * is current, where a step goes; the page only asks and draws. */
import type { DisplayRange, FindReport } from '@futo-notes/editor/wasm-payloads';

/** The `WasmSession` methods find takes (engine.ts declares the session). */
export interface RawFind {
  find_set_query(revision: bigint, query: string): string;
  find_step(revision: bigint, forward: boolean): string;
  find_close(): string;
  find_report(): string;
  find_matches(revision: bigint, start: number, end: number): string;
  find_scan_request(): string;
  find_apply_scan(result: string): string;
}

/** One note's find, at the revision the page shows. */
export class EngineFind {
  constructor(
    private readonly raw: RawFind,
    private readonly revision: bigint,
    /** The static, pure `WasmSession.find_scan`. */
    private readonly scan: (request: string) => string,
  ) {}

  /** Open find or change its query: one whole scan, the first match at or after the selection
   *  current. */
  setQuery(query: string): FindReport {
    return JSON.parse(this.raw.find_set_query(this.revision, query)) as FindReport;
  }

  /** The next or previous match, wrapping, selected in the engine. */
  step(forward: boolean): FindReport {
    return JSON.parse(this.raw.find_step(this.revision, forward)) as FindReport;
  }

  /** The matches go; the query stays for the next open, and the selection where it is. */
  close(): FindReport {
    return JSON.parse(this.raw.find_close()) as FindReport;
  }

  report(): FindReport {
    return JSON.parse(this.raw.find_report()) as FindReport;
  }

  /** The matches overlapping display bytes `range`, in display bytes. */
  matches(range: DisplayRange): DisplayRange[] {
    return JSON.parse(
      this.raw.find_matches(this.revision, range.start, range.end),
    ) as DisplayRange[];
  }

  /** Scan the whole note again and take the result: off the input path, once input has
   *  settled. Null when there is nothing to scan or the engine refused the result. The request
   *  and the result pass through unparsed. */
  rescan(): FindReport | null {
    const request = this.raw.find_scan_request();
    if (request === 'null') return null;
    return JSON.parse(this.raw.find_apply_scan(this.scan(request))) as FindReport | null;
  }
}
