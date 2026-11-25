// Integration tests: the real server process against a throwaway database.
//
// Each run starts `node Server/index.js` with LABEL_DATA_DIR pointing at a
// fresh temp folder and LABEL_PORT at a free port, then talks to it over
// HTTP - the same way the browser does. Nothing here touches Data/.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const serverFile = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'index.js',
);

let child;
let dataDir;
let base;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function api(route, { method = 'GET', body } = {}) {
  const res = await fetch(base + route, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'label-api-test-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [serverFile], {
    env: {
      ...process.env,
      DEMO_MODE: '1',
      LABEL_DATA_DIR: dataDir,
      LABEL_PORT: String(port),
    },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/state`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not start');
}, 20000);

afterAll(async () => {
  child?.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

let productId;

describe('products', () => {
  it('creates a product, upper-casing every field', async () => {
    const { status, data } = await api('/api/products', {
      method: 'POST',
      body: {
        producerNumber: 'dp1000101',
        customerCode: '001-002-000101r',
        name: 'reman inj cr delphi',
      },
    });
    expect(status).toBe(200);
    expect(data.updated).toBe(false);
    expect(data.product).toMatchObject({
      producerNumber: 'DP1000101',
      customerCode: '001-002-000101R',
      name: 'REMAN INJ CR DELPHI',
    });
    productId = data.product.id;
  });

  it('refuses a customer code with a space (it goes into the Data Matrix)', async () => {
    const { status, data } = await api('/api/products', {
      method: 'POST',
      body: { producerNumber: 'DP2', customerCode: '001 002', name: 'X' },
    });
    expect(status).toBe(400);
    expect(data.error).toMatch(/without spaces/);
  });
});

describe('OK batches - automatic serial numbers', () => {
  it('starts machine 1 at 100001 and encodes each SN in its Data Matrix', async () => {
    const { status, data } = await api('/api/batches', {
      method: 'POST',
      body: {
        productId,
        orderNumber: '4500012345',
        machine: 1,
        quantity: 3,
        repeats: 2,
      },
    });
    expect(status).toBe(200);
    expect(data.batch.labels.map((l) => l.sn)).toEqual([
      '100001',
      '100002',
      '100003',
    ]);
    expect(data.batch.labels[0].matrix).toBe('/001-002-000101R/1/100001');
    expect(data.batch.repeats).toBe(2);
  });

  it('continues the counter where the last batch ended', async () => {
    const { data } = await api('/api/batches', {
      method: 'POST',
      body: {
        productId,
        orderNumber: '4500012346',
        machine: 1,
        quantity: 2,
        repeats: 1,
      },
    });
    expect(data.batch.labels.map((l) => l.sn)).toEqual(['100004', '100005']);
    const state = await api('/api/state');
    expect(state.data.lastSerials).toEqual({ 1: 100005, 2: null });
  });

  it('keeps machine 2 in its own range', async () => {
    const { data } = await api('/api/batches', {
      method: 'POST',
      body: {
        productId,
        orderNumber: '4500012347',
        machine: 2,
        quantity: 1,
        repeats: 1,
      },
    });
    expect(data.batch.labels[0].sn).toBe('200001');
  });

  it('validates quantity, repeats and machine', async () => {
    const bad = [
      { quantity: 0, repeats: 1, machine: 1 },
      { quantity: 501, repeats: 1, machine: 1 },
      { quantity: 1, repeats: 11, machine: 1 },
      { quantity: 1, repeats: 1, machine: 3 },
    ];
    for (const b of bad) {
      const { status } = await api('/api/batches', {
        method: 'POST',
        body: { productId, orderNumber: '4500012348', ...b },
      });
      expect(status).toBe(400);
    }
  });
});

describe('OK batches - manual serial numbers', () => {
  it('prints a manual SN exactly as typed and counts up inside its width', async () => {
    const { data } = await api('/api/batches', {
      method: 'POST',
      body: {
        productId,
        orderNumber: '4500012350',
        machine: 1,
        quantity: 3,
        repeats: 1,
        startSerial: 'S00098',
      },
    });
    expect(data.batch.labels.map((l) => l.sn)).toEqual([
      'S00098',
      'S00099',
      'S00100',
    ]);
    expect(data.batch.labels[2].matrix).toBe('/001-002-000101R/1/S00100');
  });

  it('does not move the automatic counter for a differently shaped SN', async () => {
    const state = await api('/api/state');
    expect(state.data.lastSerials[1]).toBe(100005);
  });

  it('refuses to run past the width the operator typed', async () => {
    const { status, data } = await api('/api/batches', {
      method: 'POST',
      body: {
        productId,
        orderNumber: '4500012351',
        machine: 1,
        quantity: 3,
        repeats: 1,
        startSerial: 'AB98',
      },
    });
    expect(status).toBe(409);
    expect(data.error).toMatch(/AB99/);
  });

  it('refuses several pieces for an SN with no digits to count', async () => {
    const { status } = await api('/api/batches', {
      method: 'POST',
      body: {
        productId,
        orderNumber: '4500012352',
        machine: 1,
        quantity: 2,
        repeats: 1,
        startSerial: 'SPARE',
      },
    });
    expect(status).toBe(400);
  });
});

describe('NOK batches - parts that were not remanufactured', () => {
  it('derives the 9-code and the name, and encodes the grade instead of a serial', async () => {
    const { status, data } = await api('/api/nok-batches', {
      method: 'POST',
      body: {
        orderNumber: '4500012360',
        productId,
        grade: 'b',
        quantity: 2,
        repeats: 1,
      },
    });
    expect(status).toBe(200);
    expect(data.batch).toMatchObject({
      nokCode: '901-002-000101R',
      productName: 'INJ CR DELPHI',
      grade: 'B',
      matrix: '/901-002-000101R/1/901-002-000101R_B',
    });
  });

  it('never moves a machine counter', async () => {
    const state = await api('/api/state');
    expect(state.data.lastSerials).toEqual({ 1: 100005, 2: 200001 });
  });

  it('refuses a NOK code that does not start with 9', async () => {
    const { status, data } = await api('/api/nok-batches', {
      method: 'POST',
      body: {
        orderNumber: '4500012361',
        nokCode: '001-002-000101R',
        productName: 'INJ CR',
        producerNumber: 'DP1',
        grade: 'A',
        quantity: 1,
        repeats: 1,
      },
    });
    expect(status).toBe(400);
    expect(data.error).toMatch(/must start with 9/);
  });

  it('refuses an unknown grade', async () => {
    const { status } = await api('/api/nok-batches', {
      method: 'POST',
      body: {
        orderNumber: '4500012362',
        productId,
        grade: 'Z',
        quantity: 1,
        repeats: 1,
      },
    });
    expect(status).toBe(400);
  });
});

describe('void, delete and the Excel report', () => {
  it('moves a voided batch to the Voided sheet and lists NOK runs on their own sheet', async () => {
    const list = await api('/api/batches');
    const machine2 = list.data.batches.find((b) => b.machine === 2);
    await api(`/api/batches/${machine2.id}/void`, {
      method: 'POST',
      body: { voided: true },
    });

    const res = await fetch(`${base}/api/report.xlsx`);
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Labels',
      'Orders',
      'Voided',
      'NOK',
    ]);
    const serials = [];
    wb.getWorksheet('Labels').eachRow((row, n) => {
      if (n > 1) serials.push(String(row.getCell(6).value));
    });
    expect(serials).toContain('100001');
    expect(serials).toContain('S00100');
    expect(serials).not.toContain('200001');
    expect(wb.getWorksheet('Voided').rowCount).toBe(2);
    expect(wb.getWorksheet('NOK').getRow(2).getCell(5).value).toBe(
      '901-002-000101R_B',
    );
  });

  it('deleting a batch gives its serials back to the counter, voiding does not', async () => {
    const state = await api('/api/state');
    expect(state.data.lastSerials[2]).toBe(200001); // voided: still consumed
    const list = await api('/api/batches');
    const last = list.data.batches.find((b) => b.orderNumber === '4500012346');
    await api(`/api/batches/${last.id}`, { method: 'DELETE' });
    const after = await api('/api/state');
    expect(after.data.lastSerials[1]).toBe(100003);
  });
});

describe('spreadsheet import', () => {
  it('reads an .xlsx into columns and rows, skipping blank rows', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Orders');
    ws.addRow(['Order', 'Code', 'SN']);
    ws.addRow(['4500012345', '001-002-000101R', 100101]);
    ws.addRow([]);
    ws.addRow(['4500012345', '001-002-000101R', 100102]);
    const body = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await fetch(`${base}/api/import?name=orders.xlsx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body,
    });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.columns).toEqual(['Order', 'Code', 'SN']);
    expect(data.rows).toEqual([
      { Order: '4500012345', Code: '001-002-000101R', SN: '100101' },
      { Order: '4500012345', Code: '001-002-000101R', SN: '100102' },
    ]);
  });

  it('refuses the legacy .xls format with a readable message', async () => {
    const res = await fetch(`${base}/api/import?name=old.xls`, {
      method: 'POST',
      body: Buffer.from('x'),
    });
    expect(res.status).toBe(400);
  });
});

describe('print jobs (demo mode)', () => {
  it('offers the virtual demo printer instead of the Windows printer list', async () => {
    const { data } = await api('/api/printers');
    expect(data.printers).toHaveLength(1);
    expect(data.printers[0]).toMatchObject({ port: 'DEMO:', isDefault: true });
  });

  it('validates a job at the door and parks it for the headless render', async () => {
    const bad = await api('/api/print/jobs', {
      method: 'POST',
      body: { kind: 'creator', label: { w: 0, h: 20 }, elements: [] },
    });
    expect(bad.status).toBe(400);

    const ok = await api('/api/print/jobs', {
      method: 'POST',
      body: { kind: 'production', batchId: 1, copies: 500 },
    });
    expect(ok.status).toBe(200);
    const job = await api(`/api/print/jobs/${ok.data.jobId}`);
    // copies are clamped to the server's ceiling
    expect(job.data).toEqual({ kind: 'production', batchId: 1, copies: 100 });
  });
});
