import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
let pending, scenario, permissionReplies = 0;
const send = x => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\n');
const update = x => send({method:'session/update',params:{sessionId:'audit-session',update:x}});
for await (const line of createInterface({input:process.stdin})) {
 const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[]}});
 else if(m.method==='session/new'||m.method==='session/load') send({id:m.id,result:{sessionId:'audit-session'}});
 else if(m.method==='session/prompt') {
  scenario=m.params.prompt[0].text; pending=m.id;
  if(scenario==='parallel') {
   permissionReplies=0;
   for (const id of ['parallel-1','parallel-2']) send({id,method:'session/request_permission',params:{sessionId:'audit-session',toolCall:{toolCallId:id,title:'Write',kind:'edit',locations:[{path:'safe.txt'}]},options:[{kind:'allow_once',optionId:'yes',name:'Allow'},{kind:'reject_once',optionId:'no',name:'Reject'}]}});
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'requests-sent'}});
  } else if((scenario==='flood'||scenario==='large-frame')) { update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'x'.repeat(scenario==='large-frame'?2_000_000:4096)}}); send({id:m.id,result:{stopReason:'end_turn'}}); } else if(scenario==='env') {
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:process.env.BINY_ACP_AUDIT_SENTINEL??'absent'}});
   send({id:m.id,result:{stopReason:'end_turn'}});
  } else if(scenario==='unknown') {
   update({sessionUpdate:'tool_call',toolCallId:'t',title:'Write',kind:'edit',status:'in_progress'});
   send({id:m.id,result:{stopReason:'end_turn'}});
  } else {
   const locations=scenario==='multipath'?[{path:'safe.txt'},{path:'.env'}]:scenario==='credential'?[{path:'.npmrc'}]:scenario==='symlink'?[{path:'credential-link'}]:[{path:'safe.txt'}];
   send({id:'approval',method:'session/request_permission',params:{sessionId:'audit-session',toolCall:{toolCallId:'t',title:'Audit',kind:['credential','symlink'].includes(scenario)?'read':'edit',locations},options:[{kind:'allow_once',optionId:'yes',name:'Allow'},{kind:'reject_once',optionId:'no',name:'Reject'}]}});
   if(scenario==='late') send({id:m.id,result:{stopReason:'end_turn'}});
  }
 } else if(m.id==='parallel-1'||m.id==='parallel-2') { if(++permissionReplies===2) send({id:pending,result:{stopReason:'end_turn'}}); } else if(m.id==='approval') {
  writeFileSync('approval.json',JSON.stringify(m));
  if(scenario!=='late') {update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:m.result?.outcome?.optionId??'cancelled'}});send({id:pending,result:{stopReason:'end_turn'}});}
 }
}
