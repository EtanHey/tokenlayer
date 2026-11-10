import { expect, test } from 'bun:test';
import { metadata, plan, defaults, equivalent } from '../../src/fable/core';
const now = Date.now();
const signals = (u: number) => ({ observed_at: new Date(now).toISOString(), signals: {
 'Anthropic-Ratelimit-Unified-7d-Utilization': String(u), 'Anthropic-Ratelimit-Unified-7d-Status':'allowed',
 'Anthropic-Ratelimit-Unified-7d_oi-Utilization':'0.2','Anthropic-Ratelimit-Unified-7d_oi-Status':'allowed',
}});
const a = {id:'a',name:'a',email:'a',status:'active',disabled:false,unavailable:false,cooldowns:[],quota:signals(.2)};
const b = {...a,id:'b',name:'b',email:'b'};
const s = () => ({...defaults(),mode:'manual' as const,fableAccount:'a',baseline:{a:metadata({}),b:metadata({})}});
test('metadata discards all other keys; v8.0.45 file.go:497–505 / helpers.go:76–85 absent equals null',()=>{
 expect(metadata({access_token:'PRIVATE',disabled:false})).toEqual({form:'absent',disabled:false});
 expect(equivalent(metadata({}),metadata({excluded_models:null}))).toBe(true);
 expect(equivalent(metadata({excluded_models:['x']}),metadata({}))).toBe(false);
});
test('every policy row and fail-open',()=>{
 expect(plan({...s(),mode:'off'},[a,b],now).desired.a).toEqual([]);
 expect(plan(s(),[a,b],now).desired.a).toContain('claude-opus-*');
 expect(plan(s(),[a,b],now).desired.b).toEqual(['claude-fable-*']);
 expect(plan({...s(),strictFableAccount:false},[a,b],now).desired.a).toEqual([]);
 const bad={...b,status:'error'};
 expect(plan(s(),[a,bad],now).desired.a).toEqual([]);
 const capped={...a,quota:{...signals(.2),signals:{...signals(.2).signals,'Anthropic-Ratelimit-Unified-7d_oi-Utilization':'1'}}};
 expect(plan(s(),[capped,b],now).desired.b).toEqual(['claude-fable-*']);
 expect(plan({...s(),spillover:true},[capped,b],now).desired.b).toEqual([]);
 expect(plan({...s(),spillover:true},[{...a,status:'error'},b],now).desired.b).toEqual([]);
 expect(plan(s(),[{...a,status:'error'},bad],now).desired.b).toEqual([]);
 expect(plan(s(),[{...a,quota:null},b],now).reason).toBe('unreadable or stale signals');
 expect(plan(s(),[{...a,quota:{...signals(.2),observed_at:'2000-01-01'}},b],now).desired.b).toEqual([]);
 expect(plan({...s(),thresholds:{fableCapAt:.99,weeklyExhaustedAt:.1}},[a,b],now).desired.a).toEqual([]);
 expect(()=>plan({...s(),mode:'auto'},[a,b],now)).toThrow('not enabled yet');
});
