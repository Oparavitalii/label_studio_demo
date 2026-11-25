import { describe, expect, it } from 'vitest';

import {
  AUTO_SN_WIDTH,
  MACHINE_RANGES,
  NOK_GRADES,
  cellText,
  nokCodeOf,
  nokMatrixOf,
  nokNameOf,
  okMatrixOf,
  parseSerialInput,
  snOf,
} from './label_rules.js';

describe('snOf - the printed serial', () => {
  it('pads an automatic serial to six digits', () => {
    expect(snOf('', AUTO_SN_WIDTH, 100001)).toBe('100001');
    expect(snOf('', AUTO_SN_WIDTH, 42)).toBe('000042');
  });

  it('keeps a manual prefix and the width the operator typed', () => {
    expect(snOf('S', 5, 1)).toBe('S00001');
    expect(snOf('AB', 2, 9)).toBe('AB09');
  });

  it('prints the prefix alone when the SN has no digits', () => {
    expect(snOf('SPARE', 0, 0)).toBe('SPARE');
  });
});

describe('parseSerialInput - manual serial numbers', () => {
  it('returns null for an empty field, meaning "use the counter"', () => {
    expect(parseSerialInput(null)).toBeNull();
    expect(parseSerialInput('')).toBeNull();
    expect(parseSerialInput('   ')).toBeNull();
  });

  it('splits the trailing digit run off as the counter', () => {
    expect(parseSerialInput('S00001')).toEqual({
      prefix: 'S',
      width: 5,
      serial: 1,
      max: 99999,
    });
    expect(parseSerialInput('ab-09')).toEqual({
      prefix: 'AB-',
      width: 2,
      serial: 9,
      max: 99,
    });
  });

  it('treats a plain number as a prefix-less serial of its own width', () => {
    expect(parseSerialInput('000042')).toEqual({
      prefix: '',
      width: 6,
      serial: 42,
      max: 999999,
    });
    // An older client sends a number, not a string.
    expect(parseSerialInput(150000)).toMatchObject({
      prefix: '',
      serial: 150000,
    });
  });

  it('accepts an SN without digits, which can only print once', () => {
    expect(parseSerialInput('spare')).toEqual({
      prefix: 'SPARE',
      width: 0,
      serial: 0,
      max: 0,
    });
  });

  it('refuses whitespace inside the SN - it would break the Data Matrix scan', () => {
    expect(parseSerialInput('S 0001')).toEqual({
      error: 'Manual SN must not contain spaces.',
    });
  });

  it('round-trips through snOf to exactly what was typed', () => {
    for (const typed of ['S00001', '000042', 'AB09', 'X-7-0010']) {
      const p = parseSerialInput(typed);
      expect(snOf(p.prefix, p.width, p.serial)).toBe(typed);
    }
  });
});

describe('machine ranges', () => {
  it('gives each machine its own six-digit block, first digit = machine', () => {
    expect(MACHINE_RANGES[1]).toEqual({ lo: 100001, hi: 199999 });
    expect(MACHINE_RANGES[2]).toEqual({ lo: 200001, hi: 299999 });
  });
});

describe('Data Matrix payloads', () => {
  it('OK label: /CODE/1/SN', () => {
    expect(okMatrixOf('001-002-000101R', '100001')).toBe(
      '/001-002-000101R/1/100001',
    );
    expect(okMatrixOf('001-002-000101R', snOf('S', 5, 3))).toBe(
      '/001-002-000101R/1/S00003',
    );
  });

  it('NOK code: the leading 0 becomes 9, anything else is left alone', () => {
    expect(nokCodeOf('001-002-000101R')).toBe('901-002-000101R');
    expect(nokCodeOf('901-002-000101R')).toBe('901-002-000101R');
    expect(nokCodeOf('  002-004-000210R ')).toBe('902-004-000210R');
    expect(nokCodeOf('A12-000')).toBe('A12-000');
    expect(nokCodeOf(undefined)).toBe('');
  });

  it('NOK name: drops the leading REMAN, because the part was not remanufactured', () => {
    expect(nokNameOf('REMAN INJ CR DELPHI')).toBe('INJ CR DELPHI');
    expect(nokNameOf('reman  INJ CR')).toBe('INJ CR');
    expect(nokNameOf('INJ CR BOSCH')).toBe('INJ CR BOSCH');
  });

  it('NOK label: /CODE/1/CODE_GRADE - the grade replaces the serial', () => {
    expect(nokMatrixOf('901-002-000101R', 'B')).toBe(
      '/901-002-000101R/1/901-002-000101R_B',
    );
  });

  it('knows exactly the four grades of the supplier manual', () => {
    expect(Object.keys(NOK_GRADES)).toEqual(['A', 'B', 'C', 'N']);
  });
});

describe('cellText - spreadsheet cells as printed text', () => {
  it('formats dates as DD.MM.YYYY', () => {
    expect(cellText(new Date(2026, 0, 5))).toBe('05.01.2026');
  });

  it('reads rich text, formula results and hyperlinks', () => {
    expect(cellText({ richText: [{ text: 'INJ ' }, { text: 'CR' }] })).toBe(
      'INJ CR',
    );
    expect(cellText({ formula: 'A1+1', result: 42 })).toBe('42');
    expect(cellText({ text: 'site', hyperlink: 'https://example.com' })).toBe(
      'site',
    );
  });

  it('never prints [object Object] or "null"', () => {
    expect(cellText(null)).toBe('');
    expect(cellText(undefined)).toBe('');
    expect(cellText({ unknown: true })).toBe('');
  });
});
