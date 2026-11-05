import { StreamingHistoryClient } from '../../scripts/history/stream';
import { shipOnce } from '../../src/ship/ship';
const { config, options, clientOptions } = JSON.parse(process.argv[2]);
const client = new StreamingHistoryClient(config, clientOptions);
const record = client.record.bind(client);
client.record = (intent, state) => {
    if (state === 'acked')
        process.kill(process.pid, 'SIGKILL');
    record(intent, state);
};
await shipOnce({ ...options, clickhouse: client });
