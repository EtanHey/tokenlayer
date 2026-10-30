-- Metadata only. Derive the owner once per file generation, including rows with no inline id.
WITH files AS (
    SELECT machine, path, generation,
        multiIf(
            match(path, '/[^/]+/subagents/[^/]+\\.jsonl(?:\\.zst)?$'),
                extract(path, '/([^/]+)/subagents/[^/]+\\.jsonl(?:\\.zst)?$'),
            match(path, '[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}\\.jsonl(?:\\.zst)?$'),
                extract(path, '([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})\\.jsonl(?:\\.zst)?$'),
            minIf(session_id, session_id != '')
        ) AS owner
    FROM {database:Identifier}.session_events FINAL
    GROUP BY machine, path, generation
)
SELECT e.machine AS machine, f.owner AS session_id, e.path AS path,
    e.generation AS generation, e.content_hash AS content_hash, count() AS count
FROM {database:Identifier}.session_events AS e FINAL
INNER JOIN files AS f ON e.machine = f.machine AND e.path = f.path AND e.generation = f.generation
GROUP BY e.machine, f.owner, e.path, e.generation, e.content_hash
ORDER BY machine, session_id, path, generation, content_hash
FORMAT TabSeparatedWithNames
