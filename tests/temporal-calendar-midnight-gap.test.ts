/** Frozen public-API fixture: synthetic calendar response, no native process/calendar calls. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readNativeCalendar } from "../src/session/nativeCalendar.js";
const scenarios = [
  ['midnight gap at Santiago exclusive end retains prior-day last hour', 'America/Santiago', '2026-09-05', '2026-09-06', '2026-09-06T03:30:00Z', '2026-09-06T03:45:00Z', true],
  ['midnight gap at Havana exclusive end retains prior-day last hour', 'America/Havana', '2026-03-07', '2026-03-08', '2026-03-08T04:30:00Z', '2026-03-08T04:45:00Z', true],
  ['ordinary New York spring DST final hour', 'America/New_York', '2026-03-08', '2026-03-09', '2026-03-09T03:30:00Z', '2026-03-09T03:45:00Z', true],
  ['New York autumn DST repeated-hour second occurrence', 'America/New_York', '2026-11-01', '2026-11-02', '2026-11-01T06:15:00Z', '2026-11-01T06:45:00Z', true],
  ['Santiago midnight gap start includes first existing hour', 'America/Santiago', '2026-09-06', '2026-09-07', '2026-09-06T04:15:00Z', '2026-09-06T04:45:00Z', true],
  ['Shanghai local new-year last hour', 'Asia/Shanghai', '2026-12-31', '2027-01-01', '2026-12-31T15:15:00Z', '2026-12-31T15:45:00Z', true],
  ['Shanghai exclusive end rejects exact boundary', 'Asia/Shanghai', '2026-12-31', '2027-01-01', '2026-12-31T16:00:00Z', '2026-12-31T16:15:00Z', false],
  ['New York inclusive start rejects event ending exactly there', 'America/New_York', '2026-03-08', '2026-03-09', '2026-03-08T04:30:00Z', '2026-03-08T05:00:00Z', false],
  ['New York overlap across exclusive end remains included', 'America/New_York', '2026-03-08', '2026-03-09', '2026-03-09T03:30:00Z', '2026-03-09T04:30:00Z', true],
] as const;
for (const [name,timeZone,startDate,endDate,start,end,included] of scenarios) {
 test(name, async () => {
  const range = {startDate,endDate,timeZone};
  const event = {title:'Synthetic calendar event',startDate:start,endDate:end,isAllDay:false};
  let calls=0;
  const promise = readNativeCalendar(range, {authorized:true,platform:'darwin',run:async (_command: string,args: string[],options: {env:NodeJS.ProcessEnv}) => {
   calls++;
   assert.deepEqual(args,[]);
   assert.equal(options.env.BINY_CALENDAR_FROM,startDate);
   assert.equal(options.env.BINY_CALENDAR_TO,endDate);
   assert.equal(options.env.BINY_CALENDAR_ZONE,timeZone);
   return {stdout:JSON.stringify({status:'ok',events:[event],hasMore:false}),stderr:''};
  }});
  if(included) { const result=await promise; assert.equal(result.events.length,1); assert.equal(result.events[0]?.startDate,start); assert.equal(result.hasMore,false); }
  else await assert.rejects(promise,/outside the requested range/u);
  assert.equal(calls,1);
 });
}
test('invalid dates and missing authorization fail before injected backend',async()=>{
 let calls=0;
 const run=async()=>{calls++;throw new Error('must not run');};
 await assert.rejects(readNativeCalendar({startDate:'2026-02-30',endDate:'2026-03-02',timeZone:'UTC'},{authorized:true,platform:'darwin',run}),/Invalid date reference day/u);
 await assert.rejects(readNativeCalendar({startDate:'2026-02-28',endDate:'2026-03-01',timeZone:'UTC'},{authorized:false,platform:'darwin',run}),/explicit authorization/u);
 assert.equal(calls,0);
});

// Additional boundary controls; Toronto is historical algorithm coverage only.
const cases = [
 ['Toronto partial gap prior-day last instant','America/Toronto','1919-03-30','1919-03-31','1919-03-31T04:29:58Z','1919-03-31T04:29:59Z',true],
 ['Toronto partial gap excludes true next-day start','America/Toronto','1919-03-30','1919-03-31','1919-03-31T04:30:00Z','1919-03-31T04:45:00Z',false],
 ['Toronto partial gap includes first representable half hour','America/Toronto','1919-03-31','1919-04-01','1919-03-31T04:30:00Z','1919-03-31T04:45:00Z',true],
 ['Toronto partial gap start rejects event ending there','America/Toronto','1919-03-31','1919-04-01','1919-03-31T04:15:00Z','1919-03-31T04:30:00Z',false],
 ['Havana repeated midnight first occurrence','America/Havana','2026-11-01','2026-11-02','2026-11-01T04:15:00Z','2026-11-01T04:30:00Z',true],
 ['Havana repeated midnight second occurrence','America/Havana','2026-11-01','2026-11-02','2026-11-01T05:15:00Z','2026-11-01T05:30:00Z',true],
 ['Havana previous day excludes first repeated midnight','America/Havana','2026-10-31','2026-11-01','2026-11-01T04:00:00Z','2026-11-01T04:30:00Z',false],
 ['Havana first midnight start excludes prior day','America/Havana','2026-11-01','2026-11-02','2026-11-01T03:30:00Z','2026-11-01T04:00:00Z',false],
 ['Kathmandu leap day last instant','Asia/Kathmandu','2028-02-29','2028-03-01','2028-02-29T18:14:59.000Z','2028-02-29T18:15:00.000Z',true],
 ['Kathmandu leap day exclusive next month','Asia/Kathmandu','2028-02-29','2028-03-01','2028-02-29T18:15:00.000Z','2028-02-29T18:16:00.000Z',false],
 ['Santiago gap end rejects first representable next-day instant','America/Santiago','2026-09-05','2026-09-06','2026-09-06T04:00:00Z','2026-09-06T04:30:00Z',false],
 ['Santiago gap start rejects event ending at real start','America/Santiago','2026-09-06','2026-09-07','2026-09-06T03:30:00Z','2026-09-06T04:00:00Z',false],
] as const;
for(const [name,timeZone,startDate,endDate,start,end,included] of cases)test(name,async()=>{
 const event={title:'Synthetic',startDate:start,endDate:end,isAllDay:false};
 const p=readNativeCalendar({startDate,endDate,timeZone},{authorized:true,platform:'darwin',run:async()=>({stdout:JSON.stringify({status:'ok',hasMore:false,events:[event]}),stderr:''})});
 if(included)assert.equal((await p).events.length,1);else await assert.rejects(p,/outside the requested range/u);
});
