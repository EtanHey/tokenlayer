const { redactText } = await import(process.env.REDACT_MODULE || "../src/lib/redact");

// Synthetic JSONL only; generation and correctness checks are outside the timed region.
const sentinel = "syntheticBenchmarkCredential";
const line = JSON.stringify({
  type: "assistant", sessionId: "synthetic-session", timestamp: "2026-10-28T08:00:00Z",
  message: { role: "assistant", model: "claude-opus-5-5", usage: { input_tokens: 123, output_tokens: 45 },
    content: [{ type: "tool_result", content: `CLICKHOUSE_PASSWORD="${sentinel}"\nBearer ${sentinel}\nhttps://fake:${sentinel}@localhost/db` }] },
}) + "\n";
const bytes = 50_000_000;
const repeated = line.repeat(Math.floor(bytes / line.length));
const corpus = repeated + " ".repeat(bytes - repeated.length);
const expected = corpus.split(sentinel).length - 1;
redactText(corpus.slice(0, 1_000_000)); // Warmup.
const rates: number[] = [];
for (let run = 0; run < 5; run++) {
  const cpu = process.cpuUsage();
  const start = performance.now();
  const out = redactText(corpus);
  const ms = performance.now() - start;
  const used = process.cpuUsage(cpu);
  const replacements = out.split("[redacted]").length - 1;
  if (out.includes(sentinel) || replacements !== expected || !out.includes('"input_tokens":123')) {
    throw new Error("benchmark output failed correctness checks");
  }
  const mbps = bytes / 1_000_000 / (ms / 1000);
  rates.push(mbps);
  console.log(JSON.stringify({ run: run + 1, bytes, replacements, ms, mbps, cpuMs: (used.user + used.system) / 1000 }));
}
rates.sort((a, b) => a - b);
console.log(JSON.stringify({ bun: Bun.version, medianMBps: rates[2], minMBps: rates[0], maxMBps: rates[4] }));
