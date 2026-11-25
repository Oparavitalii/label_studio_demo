// The spreadsheet path: parse a file, resolve a token, count the pages.
//
// Everything here is pure - no DOM, no server - which is exactly the point:
// these are the parts a wrong answer from would print a whole roll of stock
// with {Column} on it, or with row 1 repeated fifty times.
import { describe, expect, it } from 'vitest';

import { pageCount } from './counter.js';
import {
  MAX_DATASET_ROWS,
  fitRows,
  lookup,
  normaliseColumns,
  normaliseDataset,
  parseCsv,
  rowAt,
  rowCount,
  sniffDelimiter,
  tokenColumns,
} from './dataset.js';
import { fitTexts, resolveContent } from './preview.js';
import { applyRowTokens, applyToken } from './tokens.js';

const CSV = 'Code,Name,Qty\nA-1,Filtr,10\nA-2,"Pompa, wodna",3\n';

const DATA = normaliseDataset({
  name: 'orders.csv',
  columns: ['Code', 'Name'],
  rows: [
    { Code: 'A-1', Name: 'Filtr' },
    { Code: 'A-2', Name: 'Pompa' },
    { Code: 'A-3', Name: 'Alternator kompletny' },
  ],
});

describe('parseCsv', () => {
  it('reads a comma file into columns and rows', () => {
    const { columns, rows } = parseCsv(CSV);
    expect(columns).toEqual(['Code', 'Name', 'Qty']);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ Code: 'A-1', Name: 'Filtr', Qty: '10' });
  });

  it('keeps a delimiter that sits inside quotes', () => {
    const { rows } = parseCsv(CSV);
    expect(rows[1].Name).toBe('Pompa, wodna');
  });

  it('reads the semicolons a Central-European Excel writes', () => {
    const { columns, rows } = parseCsv('Code;Name\nA-1;Filtr\n');
    expect(columns).toEqual(['Code', 'Name']);
    expect(rows[0]).toEqual({ Code: 'A-1', Name: 'Filtr' });
  });

  it('reads tab-separated exports', () => {
    const { columns, rows } = parseCsv('Code\tName\nA-1\tFiltr\n');
    expect(columns).toEqual(['Code', 'Name']);
    expect(rows[0].Name).toBe('Filtr');
  });

  it('survives CRLF, a trailing newline and blank lines', () => {
    const { rows } = parseCsv('Code,Name\r\nA-1,Filtr\r\n\r\nA-2,Pompa\r\n');
    expect(rows).toHaveLength(2);
    expect(rows[1].Code).toBe('A-2');
  });

  it('unescapes a doubled quote inside a quoted field', () => {
    const { rows } = parseCsv('Name\n"Filtr ""L"" typ"\n');
    expect(rows[0].Name).toBe('Filtr "L" typ');
  });

  // An invisible BOM would otherwise become part of the first column's name,
  // and {Code} would silently never match anything.
  it('strips a byte order mark off the first column name', () => {
    const { columns } = parseCsv('﻿Code,Name\nA-1,Filtr\n');
    expect(columns[0]).toBe('Code');
  });

  it('returns nothing usable for an empty file', () => {
    expect(parseCsv('')).toEqual({ columns: [], rows: [] });
    expect(parseCsv('   \n')).toEqual({ columns: [], rows: [] });
  });

  it('sniffs the delimiter from the header, not from the data', () => {
    // Two columns of prose full of commas, separated by semicolons: counting
    // commas anywhere but the header row would pick the wrong one.
    expect(sniffDelimiter('A;B\n"x, y, z";"p, q"\n')).toBe(';');
  });
});

describe('normaliseColumns', () => {
  it('names a blank header cell after its position, so a token exists', () => {
    expect(normaliseColumns(['Code', '', 'Qty'])).toEqual([
      'Code',
      'Column 2',
      'Qty',
    ]);
  });

  it('makes a repeated header unique instead of letting one shadow the other', () => {
    // The suffix is added to the header AS WRITTEN - a column chip showing
    // "code 3" for a header that said "code" is the honest label.
    expect(normaliseColumns(['Code', 'Code', 'code'])).toEqual([
      'Code',
      'Code 2',
      'code 3',
    ]);
  });
});

describe('normaliseDataset', () => {
  it('keeps every value as a string, so a number never prints as 1e+21', () => {
    const d = normaliseDataset({
      columns: ['Qty'],
      rows: [{ Qty: 10 }, { Qty: null }],
    });
    expect(d.rows).toEqual([{ Qty: '10' }, { Qty: '' }]);
  });

  it('refuses anything with no columns or no rows rather than half-loading', () => {
    expect(normaliseDataset(null)).toBeNull();
    expect(normaliseDataset({ columns: [], rows: [{ a: 1 }] })).toBeNull();
    expect(normaliseDataset({ columns: ['a'], rows: [] })).toBeNull();
  });

  it('caps the rows as a structural backstop behind the callers', () => {
    const rows = Array.from({ length: MAX_DATASET_ROWS + 10 }, (_, i) => ({
      Code: `A-${i}`,
    }));
    expect(normaliseDataset({ columns: ['Code'], rows }).rows).toHaveLength(
      MAX_DATASET_ROWS,
    );
  });
});

describe('rowAt / rowCount', () => {
  it('clamps past the end, the way a counter holds its last value', () => {
    expect(rowAt(DATA, 0).Code).toBe('A-1');
    expect(rowAt(DATA, 2).Code).toBe('A-3');
    expect(rowAt(DATA, 99).Code).toBe('A-3');
  });

  it('is null with no data at all, never an empty object', () => {
    expect(rowAt(null, 0)).toBeNull();
    expect(rowCount(null)).toBe(0);
    expect(rowCount(DATA)).toBe(3);
  });
});

describe('lookup / tokenColumns', () => {
  it('matches a column without case and without surrounding space', () => {
    expect(lookup({ 'Order No': 'X' }, 'order no')).toBe('X');
    expect(lookup({ 'Order No': 'X' }, ' Order No ')).toBe('X');
    expect(lookup({ 'Order No': 'X' }, 'Order')).toBeUndefined();
  });

  it('never reports {n} as a column - that one belongs to the counter', () => {
    expect(tokenColumns('{Code} {n} {Name}')).toEqual(['Code', 'Name']);
    expect(tokenColumns('S/N {n}')).toEqual([]);
  });
});

describe('applyRowTokens', () => {
  const row = { Code: 'A-1', Name: 'Filtr' };

  it('substitutes a column, spaced or differently cased', () => {
    expect(applyRowTokens('{Code}/{name}', row)).toBe('A-1/Filtr');
    expect(applyRowTokens('{ Code }', row)).toBe('A-1');
  });

  it('leaves {n} alone, so the counter still owns it', () => {
    expect(applyRowTokens('{Code}-{n}', row)).toBe('A-1-{n}');
    expect(applyToken(applyRowTokens('{Code}-{n}', row), 7)).toBe('A-1-7');
  });

  // Visible beats blank: a typo the operator can see on the first label costs
  // one label, and a silently empty field costs the whole run.
  it('leaves an unknown token written out rather than blanking it', () => {
    expect(applyRowTokens('{Kod}', row)).toBe('{Kod}');
  });
});

describe('pageCount with rows', () => {
  const num = (counter) => ({ type: 'number', counter });

  it('is the row count when the data asks for more pages than the counter', () => {
    expect(pageCount([num({ start: 1, end: 2, step: 1 })], 3)).toBe(3);
  });

  it('is the counter when the counter asks for more', () => {
    expect(pageCount([num({ start: 1, end: 10, step: 1 })], 3)).toBe(10);
  });

  it('is unchanged when nothing is imported', () => {
    expect(pageCount([{ type: 'text' }])).toBe(1);
    expect(pageCount([{ type: 'text' }], 0)).toBe(1);
  });
});

describe('resolveContent with a dataset', () => {
  it('fills a column from the row of that page', () => {
    const el = { type: 'text', content: '{Code} {Name}' };
    expect(resolveContent(el, 0, [], DATA)).toBe('A-1 Filtr');
    expect(resolveContent(el, 1, [], DATA)).toBe('A-2 Pompa');
  });

  it('fills the counter and the column on the same element', () => {
    const el = { type: 'text', content: '{Code}/{n}' };
    expect(resolveContent(el, 1, ['001', '002'], DATA)).toBe('A-2/002');
  });

  it('leaves content untouched with no data loaded', () => {
    const el = { type: 'text', content: '{Code}' };
    expect(resolveContent(el, 0, [], null)).toBe('{Code}');
  });
});

describe('fitTexts', () => {
  it('offers the LONGEST row value, not the first, so a long name cannot wrap', () => {
    const el = { type: 'text', content: '{Name}' };
    expect(fitTexts(el, DATA)).toContain('Alternator kompletny');
  });

  it('offers the plain content when the data has no such column', () => {
    const el = { type: 'text', content: '{Missing}' };
    expect(fitTexts(el, DATA)).toBe('{Missing}');
  });

  it('narrows a huge file to a handful of rows to measure', () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      Name: 'x'.repeat((i % 20) + 1),
    }));
    const big = normaliseDataset({ columns: ['Name'], rows });
    const texts = fitTexts({ type: 'text', content: '{Name}' }, big);
    expect(Array.isArray(texts)).toBe(true);
    expect(texts.length).toBeLessThanOrEqual(8);
    // The longest value in the file is what the box has to hold.
    expect(texts).toContain('x'.repeat(20));
  });

  it('crosses a counter range with the data rows', () => {
    const el = {
      type: 'number',
      content: '{Code}-{n}',
      counter: { start: 1, end: 100, step: 1 },
    };
    expect(fitTexts(el, DATA)).toContain('A-3-100');
  });

  it('gives fitRows nothing to do when the content names no column', () => {
    expect(fitRows(DATA, 'plain text')).toEqual([]);
    expect(fitRows(null, '{Code}')).toEqual([]);
  });
});
