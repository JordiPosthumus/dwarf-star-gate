// Read-only candidate narrowing for already validated finite timestamps.
// Queries include both endpoints. Callers retain their exact ownership rules;
// this index neither declares a match nor evicts any source record.
export function timeWindows(rows,field) {
  const nodes=new Map();
  for(const row of rows){
    const bucket=nodes.get(row.node)??[];
    bucket.push(row);nodes.set(row.node,bucket);
  }
  // Sort private arrays, never the caller's evidence. Equal timestamps retain
  // all rows in their original order, including anonymous and conflicting ones.
  for(const bucket of nodes.values())bucket.sort((a,b)=>a[field]-b[field]);
  return (node,from,to)=>{
    const bucket=nodes.get(node)??[];
    const bound=(value,afterEquals)=>{
      let low=0,high=bucket.length;
      while(low<high){
        const mid=low+Math.floor((high-low)/2),time=bucket[mid][field];
        if(time<value||(afterEquals&&time===value))low=mid+1;
        else high=mid;
      }
      return low;
    };
    return bucket.slice(bound(from,false),bound(to,true));
  };
}
