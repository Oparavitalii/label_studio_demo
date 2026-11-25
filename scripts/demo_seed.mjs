#!/usr/bin/env node
// Seeds a demo database with SYNTHETIC data through the real HTTP routes.
//
// Every serial number, order number, product and customer code here is
// invented (demo/fixtures/products.json). Nothing comes from production.
// Going through the API instead of writing SQL means the seed is validated,
// counted and Data-Matrix-encoded by exactly the code an operator would hit.
//
// It only seeds an EMPTY database (no products yet), so restarting the demo
// keeps whatever you printed in it.
//
//   node scripts/demo_seed.mjs [baseUrl]   (default http://localhost:5180)

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function api(base, route, { method = 'GET', body } = {}) {
  const res = await fetch(base + route, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${route}: ${data.error || res.status}`);
  }
  return data;
}

export async function waitForServer(base, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/state`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`The label server did not answer at ${base}.`);
}

export async function seedDemo(base) {
  const state = await api(base, '/api/state');
  if (state.products.length > 0) {
    console.log('Demo data already present - not seeding again.');
    return false;
  }

  const fixtures = JSON.parse(
    await readFile(
      path.join(root, 'demo', 'fixtures', 'products.json'),
      'utf8',
    ),
  );

  await api(base, '/api/settings', {
    method: 'PUT',
    body: { supplierCode: 'D 042' },
  });

  const ids = [];
  for (const product of fixtures) {
    const { product: saved } = await api(base, '/api/products', {
      method: 'POST',
      body: product,
    });
    ids.push(saved.id);
  }

  // Automatic serials on both machines (100001.., 200001..), one voided run,
  // and one manual-format run (S00001..) to show both kinds of serial.
  const batches = [
    {
      productId: ids[0],
      orderNumber: '4500012345',
      machine: 1,
      quantity: 12,
      repeats: 2,
    },
    {
      productId: ids[2],
      orderNumber: '4500012388',
      machine: 2,
      quantity: 6,
      repeats: 2,
    },
    {
      productId: ids[1],
      orderNumber: '4500012390',
      machine: 1,
      quantity: 4,
      repeats: 1,
    },
    {
      productId: ids[3],
      orderNumber: '4500012401',
      machine: 1,
      quantity: 3,
      repeats: 2,
      startSerial: 'S00001',
    },
  ];
  const created = [];
  for (const batch of batches) {
    const { batch: saved } = await api(base, '/api/batches', {
      method: 'POST',
      body: batch,
    });
    created.push(saved);
  }
  await api(base, `/api/batches/${created[2].id}/void`, {
    method: 'POST',
    body: { voided: true },
  });

  // One NOK run: a part that came back and was not remanufactured, grade B.
  // The server derives the 9-code and the name from the linked product.
  await api(base, '/api/nok-batches', {
    method: 'POST',
    body: {
      orderNumber: '4500012410',
      productId: ids[0],
      grade: 'B',
      quantity: 2,
      repeats: 1,
    },
  });

  console.log(
    `Demo data seeded: ${ids.length} products, ${created.length} batches, 1 NOK run.`,
  );
  return true;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const base = process.argv[2] || 'http://localhost:5180';
  await waitForServer(base);
  await seedDemo(base);
}
