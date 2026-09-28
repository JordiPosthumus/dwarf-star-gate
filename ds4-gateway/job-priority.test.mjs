import {test} from 'node:test';
import assert from 'node:assert/strict';
import {priorityOrder,isGenieRequest} from './job-priority.mjs';
test('Genie priority preserves conversation order and equal-rank FIFO',()=>{
 const first={key:'same',priority:'normal'},second={key:'same',geniePriority:true},other={key:'other',geniePriority:true},last={key:'last',geniePriority:true};
 assert.deepEqual(priorityOrder([first,second,other,last]),[other,last,first,second]);
 assert.equal(isGenieRequest({}, {'x-dsg-observer':'gate-genie'}),false);
 assert.equal(isGenieRequest({genie_priority_key:'fixture'}, {'x-stargate-genie-key':'fixture'}),true);
});
