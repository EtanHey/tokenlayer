import {test,expect,spyOn} from "bun:test";
import * as fs from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {readCursorProjectJsonl as read} from "../../src/metadata/cursor-project-jsonl";
import {geminiStatPin} from "../../src/metadata/gemini-json";
import {ProjectionError} from "../../src/metadata/output";
for(const badHash of [false,true]) test(`close refusal preserves fixed diagnostic; badHash=${badHash}`,()=>{
 const dir=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),"cursor-close-xs-"))), path=join(dir,"synthetic.jsonl");
 const raw=Buffer.from('{"role":"assistant","message":{"content":[]}}\n');
 fs.writeFileSync(path,raw); const pin={bytes:raw.length,sha256:badHash?"0".repeat(64):createHash("sha256").update(raw).digest("hex"),stat:geminiStatPin(fs.lstatSync(path,{bigint:true}))};
 const original=fs.closeSync;let attempts=0;
 const mock=spyOn(fs,"closeSync").mockImplementation((fd:number)=>{original(fd);attempts++;throw new Error("PRIVATE_CLOSE_BODY");});
 let error:unknown;try{read(path,pin);}catch(e){error=e;}finally{mock.mockRestore();fs.rmSync(dir,{recursive:true});}
 expect(attempts).toBe(1);expect(error).toBeInstanceOf(ProjectionError);
 expect((error as Error).message).toBe(badHash?"CURSOR_HASH_PIN":"CURSOR_IO_FAILURE");
 expect(String(error)).not.toContain("PRIVATE_CLOSE_BODY");
});
