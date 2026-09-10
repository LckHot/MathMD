/**
 * TSV-table detection and conversion (ChatGPT-style tables).
 *
 * ChatGPT's web client emits tables as plain tab-separated lines — no pipe
 * syntax, often with blank lines between rows — and renders them as real
 * <table>s. markdown-it only understands pipe tables, so raw TSV arrives in
 * the preview as one jumbled paragraph. convertTsvTables() rewrites runs of
 * tab-separated lines into GFM pipe tables; wide ones then flow through the
 * ordinary table path (host.ts wraps them in a .table-scroll container, so
 * they clip to the locked page width and scroll horizontally instead of
 * widening the page).
 *
 * The pass runs on PROTECTED text (render.ts: after protectMath, before
 * markdown-it). That placement is what makes it safe:
 *  - math in a cell is already an opaque placeholder, so splitting on tabs
 *    can never cut a formula and no raw TeX reaches the parser (invariant:
 *    math protection happens BEFORE markdown parsing);
 *  - fences and indented code blocks are already extracted, so tabs inside
 *    code are never converted.
 *
 * A run becomes a table when it holds >= minRows tab-separated lines with
 * >= minCols cells each (defaults 3 rows / 2 columns — i.e. >= 1 tab —,
 * wired from the app's Settings dialog via hostUpdate; see render.ts).
 * Blank lines inside a run are row separators and carry the run only while
 * the next line has the same cell count, so genuinely different blocks stay
 * apart. Rows are padded to the run's cell count, `|` in cells is escaped,
 * and the first row becomes the GFM header — matching how the ChatGPT
 * client renders these tables. Blank lines are inserted around the
 * converted table so it forms its own block even when the source glued it
 * to prose. Runs below the thresholds are left as prose.
 */

export interface TsvOptions {
  /** Minimum consecutive TSV lines that form a table. */
  minRows: number;
  /** Minimum cells (tab-separated) per line. */
  minCols: number;
}

const DEFAULTS: TsvOptions = { minRows: 3, minCols: 2 };

/** Defensive clamp: the Settings dialog clamps, but the values also arrive
 *  as JSON over the bridge — never trust them below the meaningful floor
 *  (1 row is not a table; 1 column means no tab at all). */
function clamp(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(2, Math.floor(value));
}

/** Consecutive (blank-line-free) TSV lines, plus their widest cell count. */
interface TsvParagraph {
  readonly rows: string[][];
  cols: number;
}

export function convertTsvTables(text: string, opts?: Partial<TsvOptions>): string {
  const minRows = clamp(opts?.minRows, DEFAULTS.minRows);
  const minCols = clamp(opts?.minCols, DEFAULTS.minCols);
  const isTsvLine = (line: string): boolean =>
    line.indexOf('\t') !== -1 && line.split('\t').length >= minCols;

  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!isTsvLine(lines[i])) {
      out.push(lines[i]);
      i++;
      continue;
    }

    // Collect the run: paragraphs of consecutive TSV lines, carried across
    // blank-line gaps while the cell count stays the same. `end` marks the
    // index after the last TSV line consumed (trailing blank lines after
    // the run stay in `lines` for the main loop to emit).
    const paras: TsvParagraph[] = [];
    let cols = minCols;
    let end = i;
    for (;;) {
      const rows: string[][] = [];
      while (end < lines.length && isTsvLine(lines[end])) {
        const cells = lines[end].split('\t');
        if (cells.length > cols) cols = cells.length;
        rows.push(cells);
        end++;
      }
      paras.push({ rows, cols });
      let next = end;
      while (next < lines.length && lines[next].trim() === '') next++;
      if (
        next < lines.length &&
        isTsvLine(lines[next]) &&
        lines[next].split('\t').length === cols
      ) {
        end = next;
        continue;
      }
      break;
    }

    const totalRows = paras.reduce((s, p) => s + p.rows.length, 0);
    if (totalRows < minRows) {
      // Below the trigger threshold: prose, not a table.
      for (let k = i; k < end; k++) out.push(lines[k]);
      i = end;
      continue;
    }

    const escapeCell = (c: string): string => c.trim().replace(/\|/g, '\\|');
    const tableLine = (cells: string[]): string => {
      const cs = cells.map(escapeCell);
      while (cs.length < cols) cs.push('');
      return `| ${cs.join(' | ')} |`;
    };
    let first = true;
    if (out.length > 0 && out[out.length - 1].trim() !== '') out.push('');
    for (const p of paras) {
      for (const cells of p.rows) {
        out.push(tableLine(cells));
        if (first) {
          first = false;
          out.push(`|${' --- |'.repeat(cols)}`);
        }
      }
    }
    if (end < lines.length && lines[end].trim() !== '') out.push('');
    i = end;
  }
  return out.join('\n');
}
