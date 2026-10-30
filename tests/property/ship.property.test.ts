import { clickhouseBinary } from "../../src/lib/local-clickhouse";
import { registerRewriteTests } from "../support/ship-rewrites";

if (!clickhouseBinary()) throw new Error("property suite requires a real local ClickHouse binary");
registerRewriteTests("property");
