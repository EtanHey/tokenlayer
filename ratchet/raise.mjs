import { readFileSync, writeFileSync } from 'node:fs';
import { raisedFloor } from './guard.mjs';
const doc = JSON.parse(readFileSync('ratchet/rows.json', 'utf8'));
const row = doc.rows.find(r => r.id === 'redactor-throughput-mbps');
row.ceiling = raisedFloor(row.ceiling, Number(process.argv[2]));
writeFileSync('ratchet/rows.json', JSON.stringify(doc, null, 2) + '\n');
