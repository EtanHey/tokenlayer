import { clickhouseBinary } from "../support/local-clickhouse";
import { registerRewriteTests } from "../support/ship-rewrites";

if (!clickhouseBinary()) throw new Error("property suite requires a real local ClickHouse binary");
registerRewriteTests("property");
