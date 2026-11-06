import { dlopen } from "bun:ffi";
import * as fs from "node:fs";
import { ProjectionError } from "./output";
const fail=():never=>{throw new ProjectionError("OUTPUT_PRIMITIVE_UNAVAILABLE");};
let symbols:any;
function native() {
  if(symbols) return symbols;
  const mac=process.platform==="darwin", linux=process.platform==="linux"&&process.arch==="x64";
  if(!mac&&!linux || !["arm64","x64"].includes(process.arch)) return fail();
  try {
    // __openat has a fixed mode argument; public Darwin openat is variadic (different arm64 ABI).
    symbols=dlopen(mac?"/usr/lib/libSystem.B.dylib":"libc.so.6",{
      [mac?"__openat":"openat"]:{args:["i32","ptr","i32","u32"],returns:"i32"},
      mkdirat:{args:["i32","ptr","u32"],returns:"i32"},
      [mac?"renameatx_np":"renameat2"]:{args:["i32","ptr","i32","ptr","u32"],returns:"i32"},
      [mac?"fstatfs64":"fstatfs"]:{args:["i32","ptr"],returns:"i32"},
    }).symbols;
    return symbols;
  } catch {return fail();}
}
const c=(s:string)=>{if(s.includes("\0")) fail();return Buffer.from(s+"\0");};
const checked=(n:number)=>{if(n<0) throw new ProjectionError("OUTPUT_CUSTODY_IO");return n;};
/** Real descriptor-relative syscalls; narrow exported seam for deterministic filesystem latches. */
export const custodyOps={
  open(fd:number,name:string,flags:number,mode=0) {
    const s=native();return checked(s[process.platform==="darwin"?"__openat":"openat"](fd,c(name),flags,mode));
  },
  mkdir(fd:number,name:string) {checked(native().mkdirat(fd,c(name),0o700));},
  commit(fd:number) {
    const s=native(), mac=process.platform==="darwin";
    // Both syscalls atomically refuse an existing destination; ordinary rename is never used.
    checked(s[mac?"renameatx_np":"renameat2"](fd,c("manifest.json.pending"),fd,c("manifest.json"),mac?4:1));
  },
  free(fd:number) {
    const b=Buffer.alloc(4096), mac=process.platform==="darwin";
    checked(native()[mac?"fstatfs64":"fstatfs"](fd,b));
    // SDK statfs64: bsize@0/free@16/avail@24. Linux x64 statfs: bsize@8/free@24/avail@32.
    const size=mac?BigInt(b.readUInt32LE(0)):b.readBigUInt64LE(8), free=b.readBigUInt64LE(mac?16:24), avail=b.readBigUInt64LE(mac?24:32);
    const bytes=Number(size*(free<avail?free:avail));
    if(size<1n || !Number.isSafeInteger(bytes) || bytes<0) return fail();return bytes;
  },
};
export const closeOnExec=process.platform==="darwin"?0x1000000:0x80000;
export const directoryFlags=fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|closeOnExec;
export const atCwd=()=>process.platform==="darwin"?-2:-100;
