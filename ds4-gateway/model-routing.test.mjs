import {test} from 'node:test';import assert from 'node:assert/strict';
import {modelRoutes,routeSelection,allowsWorker} from './model-routing.mjs';
test('route configuration and supplied header fail closed; omitted header preserves existing clients',()=>{
 const workers=[{id:'spark1'},{id:'m3'}],routes=modelRoutes({pool:['spark1','m3'],native:['m3']},workers);
 assert.equal(allowsWorker(routeSelection(routes,'native'),workers[0]),false);assert.equal(allowsWorker(routeSelection(routes,'native'),workers[1]),true);
 assert.equal(allowsWorker(routeSelection(routes,undefined),workers[0]),true);
 for(const value of ['missing',['native'],''])assert.throws(()=>routeSelection(routes,value));
 for(const value of [null,[],{native:[]},{native:['typo']},{native:'m3'}])assert.throws(()=>modelRoutes(value,workers));
});
